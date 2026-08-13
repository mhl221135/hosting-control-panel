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

[ "${AUTO_FAILOVER_ENABLED:-false}" = true ] || exit 0
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

temporary="$state.tmp.$$"
jq -n --arg checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg status "$status" \
  --argjson failures "$failures" --argjson threshold "$AUTO_FAILOVER_FAILURES" \
  '{version:1,checkedAt:$checked_at,status:$status,failures:$failures,threshold:$threshold}' > "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$state"

[ "$failures" -ge "$AUTO_FAILOVER_FAILURES" ] || exit 0
"$project_dir/scripts/check-sync-ready.sh"
recovery_id="$(jq -er '.app_data_id' /etc/hosting-control/standby-recovery.json)"
"$project_dir/scripts/activate-standby.sh" --preview \
  --hosts-file "$AUTO_FAILOVER_HOSTS_FILE" \
  --api-token-file /etc/hosting-control/cloudflare-tunnel-api.token \
  --recovery-id "$recovery_id"
"$project_dir/scripts/activate-standby.sh" --apply \
  --hosts-file "$AUTO_FAILOVER_HOSTS_FILE" \
  --api-token-file /etc/hosting-control/cloudflare-tunnel-api.token \
  --recovery-id "$recovery_id" \
  --confirm ACTIVATE-STANDBY --fence-confirm OLD-PRIMARY-FENCED

jq -n --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg recovery_id "$recovery_id" \
  '{version:1,checkedAt:$completed_at,status:"promoted",failures:0,recoveryId:$recovery_id}' > "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$state"
