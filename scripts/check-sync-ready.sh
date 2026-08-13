#!/bin/sh

set -eu

docker inspect hosting-sync >/dev/null 2>&1 \
  || { printf 'hosting-sync is unavailable.\n' >&2; exit 1; }

for folder in hosting-websites hosting-runtime-config hosting-db-recovery; do
  status="$(docker exec hosting-sync sh -c '
    key="$(sed -n "s:.*<apikey>\\(.*\\)</apikey>.*:\\1:p" /var/syncthing/config/config.xml)"
    exec wget -qO- --header="X-API-Key: $key" "http://127.0.0.1:8384/rest/db/status?folder=$1"
  ' sh "$folder")" || { printf 'Could not read Syncthing status for %s.\n' "$folder" >&2; exit 1; }
  printf '%s' "$status" | jq -e \
    '.state == "idle" and .needTotalItems == 0 and .errors == 0 and (.receiveOnlyTotalItems // 0) == 0' >/dev/null \
    || { printf 'Syncthing folder %s is not fully synchronized.\n' "$folder" >&2; exit 1; }
done

printf 'All hosting Syncthing folders are synchronized.\n'
