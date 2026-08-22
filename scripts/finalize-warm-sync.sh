#!/bin/sh

set -eu

usage() { printf 'Usage: finalize-warm-sync.sh --source|--standby [--allow-small-website-lag]\n' >&2; }
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
mode="${1:-}"
case "$mode" in --source|--standby) ;; *) usage; exit 2 ;; esac
allow_small=false
case "${2:-}" in
  "") ;;
  --allow-small-website-lag) allow_small=true ;;
  *) usage; exit 2 ;;
esac
[ "$#" -le 2 ] || { usage; exit 2; }
[ "$mode" != --standby ] || allow_small=true
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
[ -f "$env_file" ] || { printf 'Missing .env file.\n' >&2; exit 1; }

env_value() {
  awk -v key="$1" 'index($0,key "=")==1 {
    value=substr($0,length(key)+2)
    if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) value=substr(value,2,length(value)-2)
    print value; exit
  }' "$env_file"
}
root="$(env_value HOSTING_ROOT)"
root="${root:-/media/ssdmount/websites-v2}"
machine_state="$(env_value HOSTING_MACHINE_STATE_DIR)"
machine_state="${machine_state:-/etc/hosting-control}"
role="$(jq -r '.role // empty' "$machine_state/role.json" 2>/dev/null || true)"
source_release="$(cat "$project_dir/.source-release" 2>/dev/null || true)"
marker="$root/websites/.hosting-sync-baseline-complete.json"
[ -n "$source_release" ] || { printf 'Source release is missing.\n' >&2; exit 1; }

sync_status() {
  docker exec hosting-sync sh -c '
    key="$(sed -n "s:.*<apikey>\\(.*\\)</apikey>.*:\\1:p" /var/syncthing/config/config.xml)"
    exec wget -qO- --header="X-API-Key: $key" "http://127.0.0.1:8384/rest/db/status?folder=hosting-websites"
  '
}

request_rescan() {
  docker exec hosting-sync sh -c '
    key="$(sed -n "s:.*<apikey>\\(.*\\)</apikey>.*:\\1:p" /var/syncthing/config/config.xml)"
    exec wget -qO- --post-data="" --header="X-API-Key: $key" \
      "http://127.0.0.1:8384/rest/db/scan?folder=hosting-websites"
  ' >/dev/null
}

wait_for_idle() {
  allow_drift="$1"
  while :; do
    status="$(sync_status)"
    if printf '%s' "$status" | jq -e --argjson allow_drift "$allow_drift" --argjson allow_small "$allow_small" '
      .errors == 0 and ($allow_drift or ((.receiveOnlyTotalItems // 0) == 0)) and
      (if $allow_small then
        (.state == "idle" or .state == "scanning" or .state == "syncing") and
        .needTotalItems <= 100 and .needBytes <= 10485760
      else
        .state == "idle" and .needTotalItems == 0
      end)
    ' >/dev/null; then
      return 0
    fi
    if printf '%s' "$status" | jq -e '.state == "idle" and .needTotalItems == 0 and .errors > 0' >/dev/null; then
      request_rescan
    fi
    sleep 60
  done
}

if [ "$mode" = --source ]; then
  [ "$role" = primary ] || { printf 'Source finalization requires the primary role.\n' >&2; exit 1; }
  rm -f -- "$marker"
  wait_for_idle false
  # Do not publish readiness until the source remains idle across a stability
  # interval. Publishing first lets the standby reconcile against an index
  # while a follow-up scan is still active.
  sleep 10
  wait_for_idle false
  temporary="$marker.tmp.$$"
  jq -n --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg source_release "$source_release" \
    '{version:1,completed_at:$completed_at,source_release:$source_release}' > "$temporary"
  chmod 644 "$temporary"
  chown 33:33 "$temporary"
  mv "$temporary" "$marker"
  printf 'Primary warm-sync baseline is complete for source %s.\n' "$source_release"
  exit 0
fi

[ "$role" = standby ] || { printf 'Standby finalization requires the standby role.\n' >&2; exit 1; }
while :; do
  source_release="$(cat "$project_dir/.source-release" 2>/dev/null || true)"
  [ -n "$source_release" ] || { sleep 60; continue; }
  if [ -f "$marker" ] && jq -e --arg source_release "$source_release" '
    .version == 1 and .source_release == $source_release and
    (.completed_at | type == "string")
  ' "$marker" >/dev/null 2>&1; then
    break
  fi
  sleep 60
done
wait_for_idle true
docker exec hosting-sync sh -c '
  key="$(sed -n "s:.*<apikey>\\(.*\\)</apikey>.*:\\1:p" /var/syncthing/config/config.xml)"
  for folder in hosting-websites hosting-runtime-config hosting-db-recovery; do
    wget -qO- --post-data="" --header="X-API-Key: $key" \
      "http://127.0.0.1:8384/rest/db/revert?folder=$folder" >/dev/null
  done
'
while ! "$project_dir/scripts/check-sync-ready.sh" --allow-small-website-lag >/dev/null 2>&1; do sleep 60; done
"$project_dir/scripts/stage-standby-database.sh"
while ! "$project_dir/scripts/check-sync-ready.sh" --allow-small-website-lag >/dev/null 2>&1; do sleep 60; done
"$project_dir/scripts/prepare-warm-standby.sh" --apply --confirm PREPARE-WARM-STANDBY
printf 'Standby warm-sync baseline is reconciled, exact, and prepared. Promotion and traffic remain unchanged.\n'
