#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: configure-sync.sh --peer-id ID --mode sendonly|receiveonly [options]

Options:
  --peer-name NAME       Display name for the peer (default: hosting-peer)
  --peer-address ADDR    Optional direct address, for example tcp://192.0.2.10:22001
  --show-device-id       Start the container and print this server's device ID

Global discovery and relays remain enabled, so synchronization works when a
peer later moves behind CGNAT. A direct address only accelerates LAN transfer.
EOF
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
peer_id=""
peer_name="hosting-peer"
peer_address=""
mode=""
show_id=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --peer-id) shift; peer_id="${1:-}" ;;
    --peer-name) shift; peer_name="${1:-}" ;;
    --peer-address) shift; peer_address="${1:-}" ;;
    --mode) shift; mode="${1:-}" ;;
    --show-device-id) show_id=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done

[ -f "$env_file" ] || { printf 'Missing .env file.\n' >&2; exit 1; }
cd "$project_dir"
docker compose up -d hosting-sync

sync_cli() {
  docker exec hosting-sync sh -c '
    key="$(sed -n "s:.*<apikey>\\(.*\\)</apikey>.*:\\1:p" /var/syncthing/config/config.xml)"
    exec syncthing cli --gui-address=http://127.0.0.1:8384 --gui-apikey="$key" "$@"
  ' sh "$@"
}

for _ in $(seq 1 60); do
  sync_cli show system >/dev/null 2>&1 && break
  sleep 2
done
sync_cli show system >/dev/null 2>&1 \
  || { printf 'hosting-sync did not become ready.\n' >&2; exit 1; }

ignore_file="$project_dir/examples/syncthing-websites.stignore"
[ -f "$ignore_file" ] || { printf 'Missing website sync ignore file.\n' >&2; exit 1; }
docker exec -i hosting-sync sh -c '
  set -eu
  umask 027
  temporary=/var/syncthing/websites/.stignore.tmp
  trap '\''rm -f "$temporary"'\'' EXIT HUP INT TERM
  cat > "$temporary"
  mv "$temporary" /var/syncthing/websites/.stignore
  trap - EXIT HUP INT TERM
' < "$ignore_file"

device_id="$(sync_cli show system | jq -er .myID)"
if [ "$show_id" -eq 1 ] && [ -z "$peer_id" ]; then
  printf '%s\n' "$device_id"
  exit 0
fi

case "$mode" in sendonly|receiveonly) ;; *) usage; exit 2 ;; esac
case "$peer_id" in
  ???????-???????-???????-???????-???????-???????-???????-???????) ;;
  *) printf 'Peer device ID is invalid.\n' >&2; exit 2 ;;
esac
case "$peer_name" in ''|*[!A-Za-z0-9._-]*) printf 'Peer name is invalid.\n' >&2; exit 2 ;; esac
case "$peer_address" in ''|tcp://*:[0-9]*) ;; *) printf 'Peer address is invalid.\n' >&2; exit 2 ;; esac

if ! sync_cli config devices "$peer_id" dump-json >/dev/null 2>&1; then
  if [ -n "$peer_address" ]; then
    sync_cli config devices add --device-id "$peer_id" --name "$peer_name" \
      --addresses "$peer_address" --addresses dynamic
  else
    sync_cli config devices add --device-id "$peer_id" --name "$peer_name" --addresses dynamic
  fi
else
  first="${peer_address:-dynamic}"
  sync_cli config devices "$peer_id" addresses 0 set "$first"
  if [ -n "$peer_address" ]; then
    if sync_cli config devices "$peer_id" addresses 1 get >/dev/null 2>&1; then
      sync_cli config devices "$peer_id" addresses 1 set dynamic
    else
      sync_cli config devices "$peer_id" addresses add dynamic
    fi
  fi
fi

configure_folder() {
  id="$1"
  label="$2"
  folder_path="$3"
  rescan_interval=3600
  [ "$id" != hosting-websites ] || rescan_interval=86400
  if ! sync_cli config folders "$id" dump-json >/dev/null 2>&1; then
    sync_cli config folders add \
      --id "$id" --label "$label" --path "$folder_path" --type "$mode" \
      --rescan-intervals "$rescan_interval" --fswatcher-enabled --fswatcher-delays 2
  fi
  sync_cli config folders "$id" type set "$mode"
  sync_cli config folders "$id" rescan-intervals set "$rescan_interval"
  sync_cli config folders "$id" fswatcher-enabled set true
  sync_cli config folders "$id" fswatcher-delays set 2
  if ! sync_cli config folders "$id" devices "$peer_id" dump-json >/dev/null 2>&1; then
    sync_cli config folders "$id" devices add --device-id "$peer_id"
  fi
}

configure_folder hosting-websites "Hosting websites" /var/syncthing/websites
configure_folder hosting-runtime-config "Hosting runtime config" /var/syncthing/runtime-config
configure_folder hosting-db-recovery "Hosting database recovery" /var/syncthing/replication

sync_cli operations restart >/dev/null
printf 'Configured hosting-sync as %s. Device ID: %s\n' "$mode" "$device_id"
