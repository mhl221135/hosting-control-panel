#!/bin/bash
set -euo pipefail

usage() { printf 'Usage: complete-failback.sh --dry-run|--apply --peer-host HOST --peer-id ID --local-peer-id ID [--peer-root PATH] [--peer-address ADDR] [--local-address ADDR] [--api-token-file PATH] [--confirm COMPLETE-FAILBACK]\n' >&2; }
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
mode="" peer_host="" peer_root=/media/ssdmount/websites-v2 peer_id="" local_peer_id=""
peer_address="" local_address="" token_file=/etc/hosting-control/cloudflare-tunnel-api.token confirmation=""
while (( $# )); do
  case "$1" in
    --dry-run|--apply) mode="$1" ;;
    --peer-host) shift; peer_host="${1:-}" ;;
    --peer-root) shift; peer_root="${1:-}" ;;
    --peer-id) shift; peer_id="${1:-}" ;;
    --local-peer-id) shift; local_peer_id="${1:-}" ;;
    --peer-address) shift; peer_address="${1:-}" ;;
    --local-address) shift; local_address="${1:-}" ;;
    --api-token-file) shift; token_file="${1:-}" ;;
    --confirm) shift; confirmation="${1:-}" ;;
    *) usage; exit 2 ;;
  esac
  shift
done
[[ $EUID -eq 0 && -n "$mode" && "$peer_host" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || { usage; exit 2; }
[[ "$peer_root" =~ ^/[A-Za-z0-9._/-]+$ && "$peer_root" != *".."* ]] || { printf 'Peer root is invalid.\n' >&2; exit 2; }
for id in "$peer_id" "$local_peer_id"; do [[ "$id" =~ ^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$ ]] || { printf 'Peer ID is invalid.\n' >&2; exit 2; }; done
[[ -f "$token_file" && ! -L "$token_file" && $(stat -c %a "$token_file") == 600 && $(stat -c %u "$token_file") == 0 ]] \
  || { printf 'Cloudflare token file must be root-owned mode 600.\n' >&2; exit 1; }

state=/etc/hosting-control
receipt="$state/former-primary-rebuild.json"
jq -e '.role == "primary"' "$state/role.json" >/dev/null
jq -e '.status == "active"' "$state/tunnel-cutover.json" >/dev/null
jq -e '.version == 1 and .status == "prepared-standby" and (.recoveryId | type == "string")' "$receipt" >/dev/null
peer_recovery="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$peer_host" \
  cat /etc/hosting-control/standby-recovery.json)"
recovery_id="$(printf '%s' "$peer_recovery" | jq -er \
  'select(.mode == "warm-sync" and (.database_recovery_id | type == "string")) | .database_recovery_id')"
[[ "$recovery_id" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$ ]] \
  || { printf 'Peer standby recovery identifier is invalid.\n' >&2; exit 1; }
remote_accept="$peer_root/sources/scripts/accept-failback-primary.sh"
remote_lease="$peer_root/sources/scripts/witness-primary-lease.sh"
remote_args=(--dry-run --recovery-id "$recovery_id" --peer-id "$local_peer_id")
[[ -z "$local_address" ]] || remote_args+=(--peer-address "$local_address")
ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$peer_host" "$remote_accept" "${remote_args[@]}"
printf 'Failback preflight passed for recovery %s; no services or ingress changed.\n' "$recovery_id"
[[ "$mode" == --dry-run ]] && exit 0
[[ "$confirmation" == COMPLETE-FAILBACK ]] || { printf 'Apply requires --confirm COMPLETE-FAILBACK.\n' >&2; exit 2; }

cd "$project_dir"
systemctl disable --now hosting-automatic-failover.timer hosting-database-replication.timer >/dev/null 2>&1 || true
printf 'Creating a live database recovery point while HP continues serving websites.\n'
"$project_dir/scripts/create-replication-dump.sh"
recovery_id="$(find "$project_dir/../replication/database" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??-??-??Z' -printf '%f\n' | sort | tail -1)"
"$project_dir/scripts/wait-for-recovery-sync.sh" --peer-host "$peer_host" \
  --peer-root "$peer_root" --recovery-id "$recovery_id"
"$project_dir/scripts/finalize-warm-sync.sh" --source --ignore-website-state
ssh -o BatchMode=yes "root@$peer_host" systemctl restart hosting-warm-sync-finalizer.service
for _ in $(seq 1 180); do
  active="$(ssh -o BatchMode=yes "root@$peer_host" systemctl is-active hosting-warm-sync-finalizer.service 2>/dev/null || true)"
  [[ "$active" == inactive ]] && break
  [[ "$active" != failed ]] || { printf 'Peer preparation failed.\n' >&2; exit 1; }
  sleep 10
done
remote_args=(--apply --recovery-id "$recovery_id" --peer-id "$local_peer_id" --confirm ACCEPT-FAILBACK-PRIMARY)
[[ -z "$local_address" ]] || remote_args+=(--peer-address "$local_address")
ssh -o BatchMode=yes "root@$peer_host" "$remote_accept" "${remote_args[@]}"

peer_server_id="$(ssh -o BatchMode=yes "root@$peer_host" \
  jq -er 'select(.role == "primary") | .server_id | select(type == "string" and length > 0)' \
  /etc/hosting-control/role.json 2>/dev/null || true)"
[[ "$peer_server_id" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { printf 'Recovered primary server identity is invalid.\n' >&2; exit 1; }
"$project_dir/scripts/reset-witness-after-failback.sh" "$peer_server_id"
ssh -o BatchMode=yes "root@$peer_host" "$remote_lease"
ssh -o BatchMode=yes "root@$peer_host" systemctl enable --now hosting-witness-primary.timer >/dev/null
ssh -o BatchMode=yes "root@$peer_host" systemctl start hosting-witness-primary.service
ssh -o BatchMode=yes "root@$peer_host" jq -e \
  --arg server "$peer_server_id" \
  '.version == 1 and .status == "leased" and .primaryServerId == $server and (.leaseExpiresAt | fromdateiso8601) > now' \
  /etc/hosting-control/witness-primary-state.json >/dev/null
printf 'Recovered primary holds a fresh independent-witness lease.\n'

CLOUDFLARE_TUNNEL_API_TOKEN="$(cat "$token_file")"; export CLOUDFLARE_TUNNEL_API_TOKEN
"$project_dir/scripts/tunnel-cutover.sh" --rollback --confirm ROLLBACK-TUNNEL-INGRESS >/dev/null
unset CLOUDFLARE_TUNNEL_API_TOKEN
ssh -o BatchMode=yes "root@$peer_host" "$remote_accept" --mark-ingress-active \
  --recovery-id "$recovery_id" --peer-id "$local_peer_id" --confirm MARK-INGRESS-ACTIVE
printf 'OPI5 is active; keeping HP online for a 60-second ingress transition grace.\n'
sleep 60

demote_args=(--recovery-id "$recovery_id" --peer-id "$peer_id" --confirm DEMOTE-AFTER-FAILBACK)
[[ -z "$peer_address" ]] || demote_args+=(--peer-address "$peer_address")
"$project_dir/scripts/demote-after-failback.sh" "${demote_args[@]}"
ssh -o BatchMode=yes "root@$peer_host" systemctl start hosting-former-primary-fence.timer
ssh -o BatchMode=yes "root@$peer_host" systemctl start hosting-database-replication.service
printf 'Failback completed at recovery %s. The rebuilt former primary is authoritative; HP is standby.\n' "$recovery_id"
