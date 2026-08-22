#!/bin/sh

set -eu

usage() {
  printf 'Usage: accept-former-primary-rebuild.sh --dry-run|--apply --peer-id ID [--peer-address tcp://HOST:PORT] [--confirm REBUILD-AS-STANDBY]\n' >&2
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
mode="" peer_id="" peer_address="" confirmation=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run|--apply) mode="$1" ;;
    --peer-id) shift; peer_id="${1:-}" ;;
    --peer-address) shift; peer_address="${1:-}" ;;
    --confirm) shift; confirmation="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
[ -n "$mode" ] && [ -n "$peer_id" ] || { usage; exit 2; }
case "$peer_id" in ???????-???????-???????-???????-???????-???????-???????-???????) ;; *) printf 'Peer device ID is invalid.\n' >&2; exit 2 ;; esac
case "$peer_address" in ''|tcp://*:[0-9]*) ;; *) printf 'Peer address is invalid.\n' >&2; exit 2 ;; esac

state=/etc/hosting-control
role_file="$state/role.json"
fence_file="$state/former-primary-fence-state.json"
[ -f "$role_file" ] && [ -f "$fence_file" ] || { printf 'Former-primary role or fence receipt is missing.\n' >&2; exit 1; }
jq -e '.version == 1 and (.role == "primary" or .role == "standby") and (.server_id | type == "string")' "$role_file" >/dev/null \
  || { printf 'This host is not a fenced former primary or its partial standby rebuild.\n' >&2; exit 1; }
jq -e '.version == 1 and .status == "fenced" and (.peerServerId | type == "string") and (.recoveryId | type == "string")' \
  "$fence_file" >/dev/null || { printf 'The former primary is not durably fenced.\n' >&2; exit 1; }
printf 'Former primary is fenced and can be rebuilt as a receive-only standby.\n'
[ "$mode" = --dry-run ] && exit 0
[ "$confirmation" = REBUILD-AS-STANDBY ] || { printf 'Apply requires --confirm REBUILD-AS-STANDBY.\n' >&2; exit 2; }

cd "$project_dir"
systemctl disable --now hosting-database-replication.timer hosting-warm-sync-finalizer.timer >/dev/null 2>&1 || true
docker compose stop hosting-nginx hosting-php-fpm hosting-db hosting-redis hosting-billing hosting-files hosting-phpmyadmin >/dev/null

temporary="$role_file.rebuild.$$"
server_id="$(jq -r .server_id "$role_file")"
jq -n --arg server_id "$server_id" '{version:1,role:"standby",server_id:$server_id}' > "$temporary"
chmod 644 "$temporary"
mv "$temporary" "$role_file"

archive="$state/former-primary-fence-state.last-rebuild.json"
jq --arg rebuilt_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {rebuiltAt:$rebuilt_at}' "$fence_file" > "$archive.tmp.$$"
chmod 600 "$archive.tmp.$$"
mv "$archive.tmp.$$" "$archive"

set -- --peer-id "$peer_id" --peer-name promoted-primary --mode receiveonly
[ -z "$peer_address" ] || set -- "$@" --peer-address "$peer_address"
"$project_dir/scripts/configure-sync.sh" "$@"
docker compose up -d hosting-agent hosting-ui hosting-sync >/dev/null
docker restart hosting-ui >/dev/null
"$project_dir/scripts/install-warm-sync-finalizer.sh" --standby >/dev/null
printf 'Former primary is now fenced as a receive-only standby. Preparation will complete after synchronization.\n'
