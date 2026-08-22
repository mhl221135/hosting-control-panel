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
      and .errors == 0
      and (.receiveOnlyTotalItems // 0) == 0
      and .needTotalItems <= 100
      and .needBytes <= 10485760
    ' >/dev/null || {
      printf 'Syncthing folder %s exceeds the allowed website lag.\n' "$folder" >&2
      exit 1
    }
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
