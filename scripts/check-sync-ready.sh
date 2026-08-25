#!/bin/sh

set -eu

mode=exact
case "${1:-}" in
  "") ;;
  --allow-small-website-lag) mode=bounded ;;
  *) printf 'Usage: %s [--allow-small-website-lag]\n' "$0" >&2; exit 2 ;;
esac

docker inspect hosting-sync >/dev/null 2>&1 \
  || { printf 'hosting-sync is unavailable.\n' >&2; exit 1; }

for folder in hosting-websites hosting-runtime-config hosting-db-recovery; do
  status="$(docker exec hosting-sync sh -c '
    key="$(sed -n "s:.*<apikey>\\(.*\\)</apikey>.*:\\1:p" /var/syncthing/config/config.xml)"
    exec wget -qO- --header="X-API-Key: $key" "http://127.0.0.1:8384/rest/db/status?folder=$1"
  ' sh "$folder")" || { printf 'Could not read Syncthing status for %s.\n' "$folder" >&2; exit 1; }
  if [ "$mode" = bounded ] && [ "$folder" = hosting-websites ]; then
    printf '%s' "$status" | jq -e '
      (.state == "idle" or .state == "scanning" or .state == "syncing")
      and .errors <= .needTotalItems
      and .errors <= 20000
      and (.receiveOnlyTotalItems // 0) <= 100
      and .needFiles <= 20000
      and .needTotalItems <= 25000
      and .needBytes <= 268435456
    ' >/dev/null || {
      printf 'Syncthing folder %s exceeds the allowed website lag.\n' "$folder" >&2
      exit 1
    }
    continue
  fi
  if [ "$mode" = bounded ] && [ "$folder" = hosting-runtime-config ]; then
    printf '%s' "$status" | jq -e '
      .state == "idle" and .needTotalItems == 0 and .errors == 0
      and (.receiveOnlyTotalItems // 0) <= 10
      and (.receiveOnlyChangedBytes // 0) <= 1048576
    ' >/dev/null || {
      printf 'Syncthing folder %s has active or excessive local drift.\n' "$folder" >&2
      exit 1
    }
    local_changed="$(docker exec hosting-sync sh -c '
      key="$(sed -n "s:.*<apikey>\\(.*\\)</apikey>.*:\\1:p" /var/syncthing/config/config.xml)"
      exec wget -qO- --header="X-API-Key: $key" "http://127.0.0.1:8384/rest/db/localchanged?folder=$1&page=1&perpage=20"
    ' sh "$folder")" || { printf 'Could not inspect local runtime drift.\n' >&2; exit 1; }
    local_count="$(printf '%s' "$status" | jq -r '.receiveOnlyTotalItems // 0')"
    printf '%s' "$local_changed" | jq -e --argjson expected "$local_count" '
      (.files | type == "array") and (.files | length == $expected) and (.files | length <= 10)
      and all(.files[]; (.name | contains(".sync-conflict-")) and .deleted == false)
    ' >/dev/null || { printf 'Runtime drift contains a non-conflict file.\n' >&2; exit 1; }
    continue
  fi
  printf '%s' "$status" | jq -e \
    '.state == "idle" and .needTotalItems == 0 and .errors == 0 and (.receiveOnlyTotalItems // 0) == 0' >/dev/null \
    || { printf 'Syncthing folder %s is not fully synchronized.\n' "$folder" >&2; exit 1; }
done

if [ "$mode" = bounded ]; then
  printf 'Database and runtime config are exact; website lag is within the safe bound.\n'
else
  printf 'All hosting Syncthing folders are synchronized.\n'
fi
