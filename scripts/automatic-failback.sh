#!/bin/bash

set -euo pipefail

config=/etc/hosting-control/automatic-failback.env
state=/etc/hosting-control/automatic-failback-state.json
lock=/run/hosting-automatic-failback.lock
role_file=/etc/hosting-control/role.json
promotion=/etc/hosting-control/promotion-state.json
cutover=/etc/hosting-control/tunnel-cutover.json

[[ $EUID -eq 0 ]] || { printf 'Run as root.\n' >&2; exit 1; }
[[ -f "$config" && ! -L "$config" && $(stat -c %u "$config") == 0 && $(stat -c %a "$config") == 600 ]] || exit 0
# shellcheck disable=SC1090
source "$config"
[[ "${AUTO_FAILBACK_ENABLED:-false}" == true ]] || exit 0

case "${AUTO_FAILBACK_PEER_HOST:-}" in ''|*[!A-Za-z0-9.-]*) exit 1 ;; esac
[[ "${AUTO_FAILBACK_PEER_ROOT:-}" =~ ^/[A-Za-z0-9._/-]+$ && "${AUTO_FAILBACK_PEER_ROOT}" != *".."* ]] || exit 1
for id in "${AUTO_FAILBACK_PEER_SYNC_DEVICE_ID:-}" "${AUTO_FAILBACK_LOCAL_SYNC_DEVICE_ID:-}"; do
  [[ "$id" =~ ^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$ ]] || exit 1
done
for value in "${AUTO_FAILBACK_STABLE_CHECKS:-}" "${AUTO_FAILBACK_GRACE_SECONDS:-}" "${AUTO_FAILBACK_RETRY_SECONDS:-}"; do
  [[ "$value" =~ ^[0-9]+$ ]] || exit 1
done
(( AUTO_FAILBACK_STABLE_CHECKS >= 2 && AUTO_FAILBACK_STABLE_CHECKS <= 20 )) || exit 1
(( AUTO_FAILBACK_GRACE_SECONDS >= 60 && AUTO_FAILBACK_GRACE_SECONDS <= 3600 )) || exit 1
(( AUTO_FAILBACK_RETRY_SECONDS >= 300 && AUTO_FAILBACK_RETRY_SECONDS <= 86400 )) || exit 1

exec 9>"$lock"
flock -n 9 || exit 0
exec 8>/run/hosting-ha-panel-control.lock
flock -n 8 || exit 0

[[ "${AUTO_FAILBACK_CLOUDFLARE_TOKEN_FILE:-}" == /etc/hosting-control/cloudflare-tunnel-api.token ]] || exit 1
[[ -f "$AUTO_FAILBACK_CLOUDFLARE_TOKEN_FILE" && ! -L "$AUTO_FAILBACK_CLOUDFLARE_TOKEN_FILE"
  && $(stat -c %u "$AUTO_FAILBACK_CLOUDFLARE_TOKEN_FILE") == 0
  && $(stat -c %a "$AUTO_FAILBACK_CLOUDFLARE_TOKEN_FILE") == 600 ]] || exit 1

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date -u +%s; }
write_state() {
  local status_value=$1 successes_value=${2:-0} candidate_since=${3:-} recovery_id=${4:-} phase=${5:-}
  local temporary="$state.tmp.$$"
  jq -n --arg status "$status_value" --argjson successes "$successes_value" \
    --arg candidateSince "$candidate_since" --arg recoveryId "$recovery_id" \
    --arg phase "$phase" --arg checkedAt "$(now_iso)" \
    '{version:1,status:$status,successes:$successes,candidateSince:$candidateSince,
      recoveryId:$recoveryId,phase:$phase,checkedAt:$checkedAt}' > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$state"
}

role="$(jq -r '.role // empty' "$role_file" 2>/dev/null || true)"
[[ "$role" == primary ]] || exit 0
local_server_id="$(jq -r '.server_id // empty' "$role_file" 2>/dev/null || true)"
[[ "$local_server_id" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || exit 1
[[ -f "$promotion" && -f "$cutover" ]] || exit 0
recovery_id="$(jq -r '.recovery_id // empty' "$promotion" 2>/dev/null || true)"
[[ "$recovery_id" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$ ]] || exit 0
jq -e --arg recovery "$recovery_id" '
  .version == 1 and .status == "local-primary" and .previous_role == "standby"
  and .public_ingress_cutover == true and .recovery_id == $recovery
' "$promotion" >/dev/null 2>&1 || exit 0
jq -e '.version == 1 and .status == "active"' "$cutover" >/dev/null 2>&1 || exit 0

previous_status="$(jq -r '.status // empty' "$state" 2>/dev/null || true)"
if [[ "$previous_status" == failed ]]; then
  previous_checked="$(jq -r '.checkedAt // empty' "$state" 2>/dev/null || true)"
  previous_epoch="$(date -u -d "$previous_checked" +%s 2>/dev/null || printf 0)"
  (( $(now_epoch) - previous_epoch >= AUTO_FAILBACK_RETRY_SECONDS )) || exit 0
fi

peer_snapshot="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$AUTO_FAILBACK_PEER_HOST" \
  'jq -n --slurpfile role /etc/hosting-control/role.json --slurpfile fence /etc/hosting-control/former-primary-fence-state.json \
    "{role:(\$role[0] // {}),fence:(\$fence[0] // {})}"' 2>/dev/null || true)"
if ! printf '%s' "$peer_snapshot" | jq -e --arg local "$local_server_id" --arg recovery "$recovery_id" '
  .fence.version == 1 and .fence.status == "fenced"
  and .fence.peerServerId == $local and .fence.recoveryId == $recovery
  and (.role.role == "primary" or .role.role == "standby")
' >/dev/null 2>&1; then
  write_state waiting-peer 0 "" "$recovery_id" fenced-peer-required
  exit 0
fi

candidate_since="$(jq -r --arg recovery "$recovery_id" '
  select(.recoveryId == $recovery and (.candidateSince | type == "string")) | .candidateSince
' "$state" 2>/dev/null || true)"
successes="$(jq -r --arg recovery "$recovery_id" '
  select(.recoveryId == $recovery) | (.successes // 0)
' "$state" 2>/dev/null || printf 0)"
[[ "$successes" =~ ^[0-9]+$ ]] || successes=0
if [[ -z "$candidate_since" ]]; then candidate_since="$(now_iso)"; successes=0; fi
successes=$((successes + 1))
candidate_epoch="$(date -u -d "$candidate_since" +%s 2>/dev/null || printf 0)"
age=$(( $(now_epoch) - candidate_epoch ))
if (( successes < AUTO_FAILBACK_STABLE_CHECKS || age < AUTO_FAILBACK_GRACE_SECONDS )); then
  write_state waiting-stable "$successes" "$candidate_since" "$recovery_id" peer-fenced
  exit 0
fi

peer_args=(--peer-host "$AUTO_FAILBACK_PEER_HOST" --peer-root "$AUTO_FAILBACK_PEER_ROOT"
  --peer-id "$AUTO_FAILBACK_PEER_SYNC_DEVICE_ID" --local-peer-id "$AUTO_FAILBACK_LOCAL_SYNC_DEVICE_ID")
[[ -z "${AUTO_FAILBACK_PEER_SYNC_ADDRESS:-}" ]] || peer_args+=(--peer-address "$AUTO_FAILBACK_PEER_SYNC_ADDRESS")
[[ -z "${AUTO_FAILBACK_LOCAL_SYNC_ADDRESS:-}" ]] || peer_args+=(--local-address "$AUTO_FAILBACK_LOCAL_SYNC_ADDRESS")

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
write_state running "$successes" "$candidate_since" "$recovery_id" rebuild-former-primary
if ! "$project_dir/scripts/rebuild-former-primary.sh" --apply "${peer_args[@]}" --confirm REBUILD-FORMER-PRIMARY; then
  write_state failed "$successes" "$candidate_since" "$recovery_id" rebuild-former-primary
  exit 1
fi

write_state running "$successes" "$candidate_since" "$recovery_id" complete-failback
if ! "$project_dir/scripts/complete-failback.sh" --apply "${peer_args[@]}" \
  --api-token-file "$AUTO_FAILBACK_CLOUDFLARE_TOKEN_FILE" --confirm COMPLETE-FAILBACK; then
  write_state failed "$successes" "$candidate_since" "$recovery_id" complete-failback
  exit 1
fi
write_state completed "$successes" "$candidate_since" "$recovery_id" traffic-restored
printf 'Automatic failback completed; the recovered preferred primary is active.\n'
