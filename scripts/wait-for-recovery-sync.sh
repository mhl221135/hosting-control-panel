#!/bin/bash

set -euo pipefail

usage() { printf 'Usage: wait-for-recovery-sync.sh --peer-host HOST --peer-root PATH --recovery-id ID\n' >&2; }
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
peer_host="" peer_root="" recovery_id=""
while (( $# )); do
  case "$1" in
    --peer-host) shift; peer_host="${1:-}" ;;
    --peer-root) shift; peer_root="${1:-}" ;;
    --recovery-id) shift; recovery_id="${1:-}" ;;
    *) usage; exit 2 ;;
  esac
  shift
done
[[ $EUID -eq 0 && "$peer_host" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || { usage; exit 2; }
[[ "$peer_root" =~ ^/[A-Za-z0-9._/-]+$ && "$peer_root" != *".."* ]] || { usage; exit 2; }
[[ "$recovery_id" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$ ]] || { usage; exit 2; }

env_value() {
  awk -v key="$1" 'index($0,key "=")==1 {
    value=substr($0,length(key)+2)
    if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) value=substr(value,2,length(value)-2)
    print value; exit
  }' "$project_dir/.env"
}
root="$(env_value HOSTING_ROOT)"; root="${root:-/media/ssdmount/websites-v2}"
manifest="$root/replication/database/$recovery_id/manifest.json"
[[ -f "$manifest" && ! -L "$manifest" ]] || { printf 'Local recovery manifest is unavailable.\n' >&2; exit 1; }
expected_sha="$(sha256sum "$manifest" | awk '{print $1}')"

request_scan() {
  docker exec hosting-sync sh -c '
    key="$(sed -n "s:.*<apikey>\\(.*\\)</apikey>.*:\\1:p" /var/syncthing/config/config.xml)"
    exec wget -qO- --post-data="" --header="X-API-Key: $key" \
      "http://127.0.0.1:8384/rest/db/scan?folder=hosting-db-recovery"
  ' >/dev/null
}

request_scan
for attempt in $(seq 1 180); do
  remote_sum="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$peer_host" \
    "test -f '$peer_root/replication/database/$recovery_id/manifest.json' && test ! -L '$peer_root/replication/database/$recovery_id/manifest.json' && sha256sum '$peer_root/replication/database/$recovery_id/manifest.json'" \
    2>/dev/null || true)"
  remote_sha="${remote_sum%% *}"
  if [[ "$remote_sha" == "$expected_sha" ]] \
    && "$project_dir/scripts/check-sync-ready.sh" --ignore-website-state >/dev/null 2>&1 \
    && ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$peer_host" \
      "$peer_root/sources/scripts/check-sync-ready.sh" --ignore-website-state >/dev/null 2>&1; then
    printf 'Recovery %s is present and exact on the peer.\n' "$recovery_id"
    exit 0
  fi
  (( attempt % 12 != 0 )) || request_scan
  sleep 5
done
printf 'Recovery %s did not become exact on the peer before timeout.\n' "$recovery_id" >&2
exit 1
