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

for _ in $(seq 1 60); do
  docker exec hosting-sync syncthing cli show system >/dev/null 2>&1 && break
  sleep 2
done
docker exec hosting-sync syncthing cli show system >/dev/null 2>&1 \
  || { printf 'hosting-sync did not become ready.\n' >&2; exit 1; }

device_id="$(docker exec hosting-sync syncthing cli show system | jq -er .myID)"
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

addresses="dynamic"
[ -z "$peer_address" ] || addresses="$peer_address,dynamic"
if ! docker exec hosting-sync syncthing cli config devices "$peer_id" dump >/dev/null 2>&1; then
  docker exec hosting-sync syncthing cli config devices add \
    --device-id "$peer_id" --name "$peer_name" --addresses "$addresses"
fi

configure_folder() {
  id="$1"
  label="$2"
  folder_path="$3"
  if ! docker exec hosting-sync syncthing cli config folders "$id" dump >/dev/null 2>&1; then
    docker exec hosting-sync syncthing cli config folders add \
      --id "$id" --label "$label" --path "$folder_path" --type "$mode" \
      --rescan-intervals 3600 --fswatcher-enabled --fswatcher-delays 2
  fi
  if ! docker exec hosting-sync syncthing cli config folders "$id" devices "$peer_id" dump >/dev/null 2>&1; then
    docker exec hosting-sync syncthing cli config folders "$id" devices add --device-id "$peer_id"
  fi
}

configure_folder hosting-websites "Hosting websites" /var/syncthing/websites
configure_folder hosting-runtime-config "Hosting runtime config" /var/syncthing/runtime-config
configure_folder hosting-db-recovery "Hosting database recovery" /var/syncthing/replication

docker exec hosting-sync syncthing cli operations restart >/dev/null
printf 'Configured hosting-sync as %s. Device ID: %s\n' "$mode" "$device_id"
