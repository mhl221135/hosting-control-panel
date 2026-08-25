#!/bin/sh

set -eu

usage() { printf 'Usage: finalize-warm-sync.sh --source|--standby [--allow-small-website-lag|--ignore-website-state]\n' >&2; }
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
mode="${1:-}"
case "$mode" in --source|--standby) ;; *) usage; exit 2 ;; esac
sync_policy=exact
case "${2:-}" in
  "") ;;
  --allow-small-website-lag) sync_policy=bounded ;;
  --ignore-website-state) sync_policy=runtime ;;
  *) usage; exit 2 ;;
esac
[ "$#" -le 2 ] || { usage; exit 2; }
[ "$mode" != --standby ] || sync_policy=runtime
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
  [ "$sync_policy" != runtime ] || return 0
  while :; do
    status="$(sync_status)"
    if printf '%s' "$status" | jq -e --argjson allow_drift "$allow_drift" --arg policy "$sync_policy" '
      (if $policy == "bounded" then
        .errors <= .needTotalItems and .errors <= 20000
      else
        .errors == 0
      end) and
      ($allow_drift or ((.receiveOnlyTotalItems // 0) == 0)) and
      (if $policy == "bounded" then
        (.state == "idle" or .state == "scanning" or .state == "syncing") and
        .needFiles <= 20000 and .needTotalItems <= 25000 and .needBytes <= 268435456
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
  if [ "$sync_policy" != runtime ]; then
    wait_for_idle false
    sleep 10
    wait_for_idle false
  fi
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
if [ "$sync_policy" != runtime ]; then
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
fi
docker exec hosting-sync sh -c '
  key="$(sed -n "s:.*<apikey>\\(.*\\)</apikey>.*:\\1:p" /var/syncthing/config/config.xml)"
  for folder in hosting-runtime-config hosting-db-recovery; do
    wget -qO- --post-data="" --header="X-API-Key: $key" \
      "http://127.0.0.1:8384/rest/db/revert?folder=$folder" >/dev/null
  done
'
while ! "$project_dir/scripts/check-sync-ready.sh" --ignore-website-state >/dev/null 2>&1; do sleep 60; done
"$project_dir/scripts/stage-standby-database.sh"
while ! "$project_dir/scripts/check-sync-ready.sh" --ignore-website-state >/dev/null 2>&1; do sleep 60; done
"$project_dir/scripts/prepare-warm-standby.sh" --apply --confirm PREPARE-WARM-STANDBY
printf 'Standby runtime config and database recovery are exact and prepared; website sync remains advisory.\n'
