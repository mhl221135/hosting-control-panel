#!/bin/bash

set -euo pipefail

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
config=/etc/hosting-control/automatic-failover.env
state=/etc/hosting-control/automatic-failover-state.json
lock=/run/hosting-automatic-failover.lock

[ -f "$config" ] || exit 0
# The file is root-owned mode 0600 and written by install-automatic-failover.sh.
# shellcheck disable=SC1090
. "$config"

write_state() {
  state_status="$1"
  state_failures="$2"
  state_recovery_id="${3:-}"
  temporary="$state.tmp.$$"
  jq -n --arg checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg status "$state_status" --arg recovery_id "$state_recovery_id" \
    --argjson failures "$state_failures" --argjson threshold "$AUTO_FAILOVER_FAILURES" \
    '{version:1,checkedAt:$checked_at,status:$status,failures:$failures,threshold:$threshold}
     + if $recovery_id == "" then {} else {recoveryId:$recovery_id} end' > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$state"
  public_state="${AUTO_FAILOVER_PUBLIC_STATE_FILE:-$project_dir/../app-data/ui-manager/automatic-failover-state.json}"
  public_dir="$(dirname -- "$public_state")"
  if [ -d "$public_dir" ] && [ ! -L "$public_dir" ]; then
    public_temporary="$public_state.tmp.$$"
    if cp "$state" "$public_temporary" && chmod 644 "$public_temporary" \
      && mv "$public_temporary" "$public_state"; then
      :
    else
      rm -f "$public_temporary"
      printf 'Warning: automatic failover panel status could not be published.\n' >&2
    fi
  fi
}

valid_fence_receipt() {
  receipt="${AUTO_FAILOVER_FENCE_RECEIPT:-/etc/hosting-control/primary-fence-receipt.json}"
  [ -f "$receipt" ] && [ ! -L "$receipt" ] || return 1
  [ "$(stat -c '%u' "$receipt" 2>/dev/null || true)" = 0 ] || return 1
  [ "$(stat -c '%a' "$receipt" 2>/dev/null || true)" = 600 ] || return 1
  jq -e --arg primary "${AUTO_FAILOVER_PRIMARY_SERVER_ID:-}" --arg recovery "$1" \
    --argjson max_age "${AUTO_FAILOVER_FENCE_MAX_AGE_SECONDS:-900}" '
      .version == 1 and .status == "fenced"
      and .primaryServerId == $primary and .recoveryId == $recovery
      and (.method | IN("power", "network", "service"))
      and ((.fencedAt | fromdateiso8601) <= (now + 30))
      and ((now - (.fencedAt | fromdateiso8601)) <= $max_age)
      and ((.expiresAt | fromdateiso8601) >= now)
    ' "$receipt" >/dev/null 2>&1
}

case "${AUTO_FAILOVER_ENABLED:-false}" in
  true) ;;
  false) write_state disabled 0; exit 0 ;;
  *) exit 1 ;;
esac
case "${AUTO_FAILOVER_MODE:-monitor}" in monitor|activate) ;; *) exit 1 ;; esac
case "${AUTO_FAILOVER_FAILURES:-6}" in ''|*[!0-9]*) exit 1 ;; esac
[ "$AUTO_FAILOVER_FAILURES" -ge 3 ] && [ "$AUTO_FAILOVER_FAILURES" -le 30 ] || exit 1
case "${PRIMARY_HEALTH_URL:-}" in https://*) ;; *) exit 1 ;; esac
[ -f "${AUTO_FAILOVER_HOSTS_FILE:-}" ] || exit 1

exec 9>"$lock"
flock -n 9 || exit 0
role="$(jq -r '.role // empty' /etc/hosting-control/role.json 2>/dev/null || true)"
[ "$role" = standby ] || exit 0

healthy=0
response="$(curl -fsS --max-time 8 --connect-timeout 4 "$PRIMARY_HEALTH_URL" 2>/dev/null || true)"
printf '%s' "$response" | jq -e '.ok == true and .role == "primary"' >/dev/null 2>&1 && healthy=1

peer_connected=0
connection="$(docker exec hosting-sync sh -c '
  key="$(sed -n "s:.*<apikey>\\(.*\\)</apikey>.*:\\1:p" /var/syncthing/config/config.xml)"
  wget -qO- --header="X-API-Key: $key" http://127.0.0.1:8384/rest/system/connections
' 2>/dev/null || true)"
printf '%s' "$connection" | jq -e '[.connections[]? | select(.connected == true)] | length > 0' >/dev/null 2>&1 \
  && peer_connected=1

previous="$(jq -r '.failures // 0' "$state" 2>/dev/null || printf 0)"
case "$previous" in ''|*[!0-9]*) previous=0 ;; esac
if [ "$healthy" -eq 1 ] || [ "$peer_connected" -eq 1 ]; then
  failures=0
  status=healthy
else
  failures=$((previous + 1))
  status=primary-unreachable
fi

write_state "$status" "$failures"

[ "$failures" -ge "$AUTO_FAILOVER_FAILURES" ] || exit 0
if ! "$project_dir/scripts/check-sync-ready.sh"; then
  write_state blocked-sync "$failures"
  exit 1
fi
if ! recovery_id="$(jq -er '.app_data_id' /etc/hosting-control/standby-recovery.json)"; then
  write_state blocked-recovery "$failures"
  exit 1
fi

if [ "${AUTO_FAILOVER_MODE:-monitor}" = monitor ]; then
  write_state threshold-reached "$failures" "$recovery_id"
  printf 'Automatic failover threshold reached; monitor mode will not promote.\n' >&2
  exit 0
fi

case "${AUTO_FAILOVER_PRIMARY_SERVER_ID:-}" in
  ''|*[!A-Za-z0-9._-]*) write_state invalid-config "$failures" "$recovery_id"; exit 1 ;;
esac
case "${AUTO_FAILOVER_FENCE_MAX_AGE_SECONDS:-900}" in ''|*[!0-9]*) exit 1 ;; esac
[ "${AUTO_FAILOVER_FENCE_MAX_AGE_SECONDS:-900}" -ge 60 ] \
  && [ "${AUTO_FAILOVER_FENCE_MAX_AGE_SECONDS:-900}" -le 3600 ] || exit 1
if ! valid_fence_receipt "$recovery_id"; then
  write_state awaiting-fence "$failures" "$recovery_id"
  printf 'Automatic failover is waiting for a fresh fencing receipt for %s.\n' \
    "$AUTO_FAILOVER_PRIMARY_SERVER_ID" >&2
  exit 0
fi

write_state activating "$failures" "$recovery_id"
if ! "$project_dir/scripts/activate-standby.sh" --preview \
  --hosts-file "$AUTO_FAILOVER_HOSTS_FILE" \
  --api-token-file /etc/hosting-control/cloudflare-tunnel-api.token \
  --recovery-id "$recovery_id"; then
  write_state preview-failed "$failures" "$recovery_id"
  exit 1
fi
if ! "$project_dir/scripts/activate-standby.sh" --apply \
  --hosts-file "$AUTO_FAILOVER_HOSTS_FILE" \
  --api-token-file /etc/hosting-control/cloudflare-tunnel-api.token \
  --recovery-id "$recovery_id" \
  --confirm ACTIVATE-STANDBY --fence-confirm OLD-PRIMARY-FENCED; then
  write_state activation-failed "$failures" "$recovery_id"
  exit 1
fi

write_state promoted 0 "$recovery_id"
rm -f "${AUTO_FAILOVER_FENCE_RECEIPT:-/etc/hosting-control/primary-fence-receipt.json}"
