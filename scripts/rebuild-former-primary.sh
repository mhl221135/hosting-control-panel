#!/bin/bash

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: rebuild-former-primary.sh --dry-run|--apply --peer-host HOST --peer-id ID --local-peer-id ID [options]

Options:
  --peer-root PATH       Former-primary installation root (default: /media/ssdmount/websites-v2)
  --peer-address ADDR    Direct Syncthing address advertised to the former primary
  --local-address ADDR   Direct Syncthing address advertised to this host
  --confirm TEXT         Required with --apply; must be REBUILD-FORMER-PRIMARY

Apply briefly pauses website writes while producing and synchronizing the final
logical database recovery point. It never changes DNS or public ingress.
EOF
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
mode="" peer_host="" peer_root=/media/ssdmount/websites-v2 peer_id="" local_peer_id=""
peer_address="" local_address="" confirmation=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run|--apply) mode="$1" ;;
    --peer-host) shift; peer_host="${1:-}" ;;
    --peer-root) shift; peer_root="${1:-}" ;;
    --peer-id) shift; peer_id="${1:-}" ;;
    --local-peer-id) shift; local_peer_id="${1:-}" ;;
    --peer-address) shift; peer_address="${1:-}" ;;
    --local-address) shift; local_address="${1:-}" ;;
    --confirm) shift; confirmation="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
[ -n "$mode" ] && [ -n "$peer_host" ] && [ -n "$peer_id" ] && [ -n "$local_peer_id" ] || { usage; exit 2; }
[[ "$peer_host" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || { printf 'Peer host is invalid.\n' >&2; exit 2; }
[[ "$peer_root" =~ ^/[A-Za-z0-9._/-]+$ && "$peer_root" != *".."* ]] || { printf 'Peer root is invalid.\n' >&2; exit 2; }
for id in "$peer_id" "$local_peer_id"; do
  [[ "$id" =~ ^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$ ]] || { printf 'Syncthing device ID is invalid.\n' >&2; exit 2; }
done
for address in "$peer_address" "$local_address"; do
  [[ -z "$address" || "$address" =~ ^tcp://[A-Za-z0-9.:-]+:[0-9]+$ ]] || { printf 'Syncthing address is invalid.\n' >&2; exit 2; }
done

role=/etc/hosting-control/role.json
promotion=/etc/hosting-control/promotion-state.json
cutover=/etc/hosting-control/tunnel-cutover.json
jq -e '.version == 1 and .role == "primary"' "$role" >/dev/null || { printf 'Run on the promoted primary.\n' >&2; exit 1; }
jq -e '.version == 1 and .status == "local-primary" and .previous_role == "standby" and .public_ingress_cutover == true' \
  "$promotion" >/dev/null || { printf 'Promoted-primary state with active ingress is required.\n' >&2; exit 1; }
jq -e '.version == 1 and .status == "active"' "$cutover" >/dev/null || { printf 'Active tunnel cutover receipt is required.\n' >&2; exit 1; }

remote_script="$peer_root/sources/scripts/accept-former-primary-rebuild.sh"
remote_args=(--dry-run --peer-id "$local_peer_id")
[[ -z "$local_address" ]] || remote_args+=(--peer-address "$local_address")
ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$peer_host" "$remote_script" "${remote_args[@]}"
printf 'Former-primary rebuild preflight passed. Public ingress was not changed.\n'
[ "$mode" = --dry-run ] && exit 0
[ "$confirmation" = REBUILD-FORMER-PRIMARY ] || { printf 'Apply requires --confirm REBUILD-FORMER-PRIMARY.\n' >&2; exit 2; }

cd "$project_dir"
set -- --peer-id "$peer_id" --peer-name former-primary --mode sendonly
[ -z "$peer_address" ] || set -- "$@" --peer-address "$peer_address"
"$project_dir/scripts/configure-sync.sh" "$@"
remote_args=(--apply --peer-id "$local_peer_id" --confirm REBUILD-AS-STANDBY)
[[ -z "$local_address" ]] || remote_args+=(--peer-address "$local_address")
ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$peer_host" "$remote_script" "${remote_args[@]}"

docker compose stop hosting-nginx hosting-php-fpm hosting-billing >/dev/null
resume_writes() { docker compose up -d hosting-php-fpm hosting-nginx hosting-billing >/dev/null 2>&1 || true; }
trap resume_writes EXIT HUP INT TERM
"$project_dir/scripts/create-replication-dump.sh"
recovery_id="$(find "$project_dir/../replication/database" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??-??-??Z' -printf '%f\n' | sort | tail -1)"
[ -n "$recovery_id" ] || { printf 'Final database recovery point was not created.\n' >&2; exit 1; }

ready_count=0
for _ in $(seq 1 90); do
  if "$project_dir/scripts/check-sync-ready.sh" --allow-small-website-lag >/dev/null 2>&1 \
    && ssh -o BatchMode=yes "root@$peer_host" "$peer_root/sources/scripts/check-sync-ready.sh" --allow-small-website-lag >/dev/null 2>&1; then
    ready_count=$((ready_count + 1))
    [ "$ready_count" -ge 2 ] && break
  else
    ready_count=0
  fi
  sleep 10
done
"$project_dir/scripts/check-sync-ready.sh" --allow-small-website-lag >/dev/null
ssh -o BatchMode=yes "root@$peer_host" "$peer_root/sources/scripts/check-sync-ready.sh" --allow-small-website-lag >/dev/null

"$project_dir/scripts/finalize-warm-sync.sh" --source --allow-small-website-lag
ssh -o BatchMode=yes "root@$peer_host" systemctl restart hosting-warm-sync-finalizer.service
for _ in $(seq 1 180); do
  active="$(ssh -o BatchMode=yes "root@$peer_host" systemctl is-active hosting-warm-sync-finalizer.service 2>/dev/null || true)"
  [ "$active" = inactive ] && break
  [ "$active" != failed ] || { printf 'Former-primary standby preparation failed.\n' >&2; exit 1; }
  sleep 10
done
remote_recovery="$(ssh -o BatchMode=yes "root@$peer_host" cat /etc/hosting-control/standby-recovery.json)"
printf '%s' "$remote_recovery" | jq -e --arg id "$recovery_id" \
  '.mode == "warm-sync" and .database_recovery_id == $id' >/dev/null

receipt=/etc/hosting-control/former-primary-rebuild.json
jq -n --arg peer "$peer_host" --arg recovery_id "$recovery_id" --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{version:1,status:"prepared-standby",peer:$peer,recoveryId:$recovery_id,completedAt:$completed_at}' > "$receipt.tmp.$$"
chmod 600 "$receipt.tmp.$$"
mv "$receipt.tmp.$$" "$receipt"
trap - EXIT HUP INT TERM
resume_writes
printf 'Former primary is rebuilt and verified as standby at recovery %s. HP remains the active primary.\n' "$recovery_id"
