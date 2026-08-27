#!/bin/sh
set -eu

config=/etc/hosting-control/ha-panel-control.env
[ -r "$config" ] || exit 0
# shellcheck disable=SC1090
. "$config"

request="$HA_PANEL_DATA_DIR/ha-control-request.json"
result="$HA_PANEL_DATA_DIR/ha-control-result.json"
processing="$HA_PANEL_DATA_DIR/ha-control-request.processing.json"
role_file=/etc/hosting-control/role.json
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
mkdir -p "$HA_PANEL_DATA_DIR"
exec 9>/run/hosting-ha-panel-control.lock
flock -n 9 || exit 0
[ -f "$request" ] || [ -f "$processing" ] || exit 0
if [ ! -f "$processing" ]; then mv "$request" "$processing"; fi

finish() {
  status=$1 message=$2
  temporary="$result.tmp.$$"
  jq -n --arg id "$id" --arg action "$action" --arg status "$status" --arg message "$message" \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{version:1,id:$id,action:$action,status:$status,message:$message,completedAt:$completedAt}' > "$temporary"
  chmod 0644 "$temporary"
  mv "$temporary" "$result"
  rm -f "$processing"
}

if ! jq -e '.version == 1 and (.id|type == "string") and (.action|type == "string") and (.serverId|type == "string")' "$processing" >/dev/null 2>&1; then
  id=invalid action=invalid
  finish rejected "Invalid HA control request"
  exit 0
fi
id=$(jq -r '.id' "$processing")
action=$(jq -r '.action' "$processing")
requested_server=$(jq -r '.serverId' "$processing")
role=$(jq -r '.role // empty' "$role_file" 2>/dev/null || true)
server=$(jq -r '.server_id // .serverId // empty' "$role_file" 2>/dev/null || true)
if [ -z "$server" ] || [ "$requested_server" != "$server" ]; then
  finish rejected "Server identity changed before the request was processed"
  exit 0
fi

unit=
case "$role:$action" in
  primary:replicate-now) unit=hosting-database-replication.service ;;
  standby:finalize-standby) unit=hosting-warm-sync-finalizer.service ;;
  standby:failover-check) unit=hosting-automatic-failover.service ;;
  standby:failover-hosts-preview|standby:accept-failover-hosts)
    recovery_id=$(jq -r '.app_data_id // empty' /etc/hosting-control/standby-recovery.json 2>/dev/null || true)
    case "$recovery_id" in ????-??-??T??-??-??Z) ;; *) finish failed "Prepared recovery point is unavailable"; exit 0 ;; esac
    if [ "$action" = failover-hosts-preview ]; then
      if "$project_dir/scripts/qualify-failover-hosts.sh" --preview >/dev/null 2>&1; then
        finish succeeded "Cloudflare failover-host preview passed for $recovery_id"
      else finish failed "Failover-host preview failed; inspect the host journal"; fi
    elif "$project_dir/scripts/qualify-failover-hosts.sh" --apply --recovery-id "$recovery_id" \
      --confirm ACCEPT-QUALIFIED-FAILOVER-HOSTS >/dev/null 2>&1; then
      finish succeeded "Cloudflare-qualified failover hosts accepted for $recovery_id"
    else finish failed "Failover-host acceptance failed; inspect the host journal"; fi
    exit 0 ;;
  standby:request-witness-fence)
    recovery_id=$(jq -r '.database_recovery_id // .app_data_id // empty' /etc/hosting-control/standby-recovery.json 2>/dev/null || true)
    case "$recovery_id" in ????-??-??T??-??-??Z) ;; *) finish failed "Prepared recovery point is unavailable"; exit 0 ;; esac
    [ -f /etc/hosting-control/external-witness.env ] || { finish failed "External witness is not configured"; exit 0; }
    if node "$project_dir/scripts/request-witness-fence.js" "$recovery_id" >/dev/null 2>&1; then
      finish succeeded "External witness fenced the primary for $recovery_id"
    else finish failed "External witness request failed; promotion remains blocked"; fi
    exit 0 ;;
  standby:promotion-preview|standby:promote-standby)
    recovery_id=$(jq -r '.database_recovery_id // .app_data_id // empty' /etc/hosting-control/standby-recovery.json 2>/dev/null || true)
    hosts_file=$(sed -n "s/^AUTO_FAILOVER_HOSTS_FILE='\(.*\)'$/\1/p" /etc/hosting-control/automatic-failover.env 2>/dev/null)
    token_file=/etc/hosting-control/cloudflare-tunnel-api.token
    case "$recovery_id" in ????-??-??T??-??-??Z) ;; *) finish failed "Prepared recovery point is unavailable"; exit 0 ;; esac
    [ -n "$hosts_file" ] && [ -f "$hosts_file" ] || { finish failed "Qualified failover host list is unavailable"; exit 0; }
    if [ "$action" = promotion-preview ]; then
      if "$project_dir/scripts/activate-standby.sh" --preview --hosts-file "$hosts_file" \
        --api-token-file "$token_file" --recovery-id "$recovery_id" >/dev/null 2>&1; then
        finish succeeded "Promotion and public-ingress preview passed for $recovery_id"
      else finish failed "Promotion preview failed; inspect the host journal"; fi
      exit 0
    fi
    fence_confirmation=
    if grep -q "^AUTO_FAILOVER_FENCE_POLICY='unreachable'$" /etc/hosting-control/automatic-failover.env 2>/dev/null \
      && grep -q "^AUTO_FAILOVER_UNREACHABLE_RISK_ACCEPTED='I-ACCEPT-SPLIT-BRAIN-RISK'$" /etc/hosting-control/automatic-failover.env 2>/dev/null; then
      grace=$(sed -n "s/^AUTO_FAILOVER_UNREACHABLE_GRACE_SECONDS='\([0-9][0-9]*\)'$/\1/p" /etc/hosting-control/automatic-failover.env)
      state=/etc/hosting-control/automatic-failover-state.json
      if [ -n "$grace" ] && jq -e --argjson grace "$grace" '
        .version == 1 and .status == "awaiting-unreachable-grace" and .failures >= .threshold
        and ((now - (.unreachableSince | fromdateiso8601)) >= $grace)
      ' "$state" >/dev/null 2>&1; then
        fence_confirmation=PRIMARY-UNREACHABLE-RISK-ACCEPTED
      fi
    else
      receipt=/etc/hosting-control/primary-fence-receipt.json
      primary_id=$(sed -n "s/^AUTO_FAILOVER_PRIMARY_SERVER_ID='\(.*\)'$/\1/p" /etc/hosting-control/automatic-failover.env 2>/dev/null)
      if [ -f "$receipt" ] && [ ! -L "$receipt" ] && [ "$(stat -c %u "$receipt" 2>/dev/null)" = 0 ] \
        && [ "$(stat -c %a "$receipt" 2>/dev/null)" = 600 ] \
        && jq -e --arg primary "$primary_id" --arg recovery "$recovery_id" \
          '.version == 1 and .status == "fenced" and .primaryServerId == $primary and .recoveryId == $recovery and (.expiresAt|fromdateiso8601) >= now' \
          "$receipt" >/dev/null 2>&1; then
        fence_confirmation=OLD-PRIMARY-FENCED
      fi
    fi
    [ -n "$fence_confirmation" ] || { finish failed "Promotion requires a current external-fencing receipt"; exit 0; }
    if "$project_dir/scripts/activate-standby.sh" --apply --hosts-file "$hosts_file" --api-token-file "$token_file" \
      --recovery-id "$recovery_id" --confirm ACTIVATE-STANDBY --fence-confirm "$fence_confirmation" >/dev/null 2>&1; then
      finish succeeded "Standby promoted and public ingress activated at $recovery_id"
    else finish failed "Standby promotion failed; inspect the host journal"; fi
    exit 0 ;;
  primary:rebuild-preview|primary:rebuild-former-primary|primary:failback-preview|primary:complete-failback)
    for value in "${HA_PEER_SSH_HOST:-}" "${HA_PEER_SYNC_DEVICE_ID:-}" "${HA_LOCAL_SYNC_DEVICE_ID:-}"; do
      [ -n "$value" ] || { finish failed "HA peer operation settings are incomplete"; exit 0; }
    done
    peer_root=${HA_PEER_ROOT:-/media/ssdmount/websites-v2}
    if [ "$action" = rebuild-preview ] || [ "$action" = rebuild-former-primary ]; then
      set -- "$project_dir/scripts/rebuild-former-primary.sh" --peer-host "$HA_PEER_SSH_HOST" --peer-root "$peer_root" \
        --peer-id "$HA_PEER_SYNC_DEVICE_ID" --local-peer-id "$HA_LOCAL_SYNC_DEVICE_ID"
      [ -z "${HA_PEER_SYNC_ADDRESS:-}" ] || set -- "$@" --peer-address "$HA_PEER_SYNC_ADDRESS"
      [ -z "${HA_LOCAL_SYNC_ADDRESS:-}" ] || set -- "$@" --local-address "$HA_LOCAL_SYNC_ADDRESS"
      if [ "$action" = rebuild-preview ]; then set -- "$@" --dry-run; else set -- "$@" --apply --confirm REBUILD-FORMER-PRIMARY; fi
    else
      set -- "$project_dir/scripts/complete-failback.sh" --peer-host "$HA_PEER_SSH_HOST" --peer-root "$peer_root" \
        --peer-id "$HA_PEER_SYNC_DEVICE_ID" --local-peer-id "$HA_LOCAL_SYNC_DEVICE_ID"
      [ -z "${HA_PEER_SYNC_ADDRESS:-}" ] || set -- "$@" --peer-address "$HA_PEER_SYNC_ADDRESS"
      [ -z "${HA_LOCAL_SYNC_ADDRESS:-}" ] || set -- "$@" --local-address "$HA_LOCAL_SYNC_ADDRESS"
      if [ "$action" = failback-preview ]; then set -- "$@" --dry-run; else set -- "$@" --apply --confirm COMPLETE-FAILBACK; fi
    fi
    if "$@" >/dev/null 2>&1; then finish succeeded "$action completed"; else finish failed "$action failed; inspect the host journal"; fi
    exit 0 ;;
  *) finish rejected "Action is not allowed for the current machine role"; exit 0 ;;
esac

unit_state=$(systemctl show "$unit" --property=ActiveState --value 2>/dev/null || true)
if [ "$unit_state" = active ] || [ "$unit_state" = activating ] || [ "$unit_state" = reloading ]; then
  finish succeeded "$unit is already running"
elif systemctl start "$unit"; then
  finish succeeded "$unit completed"
else
  finish failed "$unit failed"
fi
