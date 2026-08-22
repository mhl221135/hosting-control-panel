#!/bin/bash
set -euo pipefail

usage() { printf 'Usage: demote-after-failback.sh --recovery-id ID --peer-id ID [--peer-address ADDR] --confirm DEMOTE-AFTER-FAILBACK\n' >&2; }
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
recovery_id="" peer_id="" peer_address="" confirmation=""
while (( $# )); do
  case "$1" in
    --recovery-id) shift; recovery_id="${1:-}" ;;
    --peer-id) shift; peer_id="${1:-}" ;;
    --peer-address) shift; peer_address="${1:-}" ;;
    --confirm) shift; confirmation="${1:-}" ;;
    *) usage; exit 2 ;;
  esac
  shift
done
[[ $EUID -eq 0 && "$confirmation" == DEMOTE-AFTER-FAILBACK ]] || { usage; exit 2; }
[[ "$recovery_id" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$ ]] || { printf 'Recovery ID is invalid.\n' >&2; exit 2; }
[[ "$peer_id" =~ ^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$ ]] || { printf 'Peer ID is invalid.\n' >&2; exit 2; }

state=/etc/hosting-control
jq -e '.version == 1 and .role == "primary"' "$state/role.json" >/dev/null
jq -e '.version == 1 and .status == "local-primary" and .public_ingress_cutover == false and
  (.recovery_id | type == "string")' "$state/promotion-state.json" >/dev/null
jq -e '.version == 1 and .status == "rolled-back"' "$state/tunnel-cutover.json" >/dev/null
cd "$project_dir"
systemctl disable --now hosting-database-replication.timer hosting-automatic-failover.timer >/dev/null 2>&1 || true
docker compose stop hosting-npm hosting-phpmyadmin hosting-files hosting-billing hosting-nginx hosting-php-fpm hosting-redis hosting-db hosting-ui >/dev/null

server_id="$(jq -r .server_id "$state/role.json")"
jq -n --arg server_id "$server_id" '{version:1,role:"standby",server_id:$server_id}' > "$state/role.json.tmp.$$"
chmod 644 "$state/role.json.tmp.$$"; mv "$state/role.json.tmp.$$" "$state/role.json"
for name in promotion-state tunnel-cutover; do
  [ -f "$state/$name.json" ] || continue
  mv "$state/$name.json" "$state/$name.last-failback.json"
done
sync_args=(--peer-id "$peer_id" --peer-name authoritative-primary --mode receiveonly)
[[ -z "$peer_address" ]] || sync_args+=(--peer-address "$peer_address")
"$project_dir/scripts/configure-sync.sh" "${sync_args[@]}"
docker compose up -d hosting-agent hosting-ui hosting-cloudflared hosting-sync >/dev/null
"$project_dir/scripts/install-warm-sync-finalizer.sh" --standby >/dev/null
systemctl enable --now hosting-automatic-failover.timer >/dev/null 2>&1 || true
printf 'Previous HP primary demoted to receive-only standby after recovery %s.\n' "$recovery_id"
