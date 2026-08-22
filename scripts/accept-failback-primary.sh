#!/bin/bash
set -euo pipefail

usage() { printf 'Usage: accept-failback-primary.sh --dry-run|--apply|--mark-ingress-active --recovery-id ID --peer-id ID [--peer-address ADDR] [--confirm TEXT]\n' >&2; }
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
mode="" recovery_id="" peer_id="" peer_address="" confirmation=""
while (( $# )); do
  case "$1" in
    --dry-run|--apply|--mark-ingress-active) mode="$1" ;;
    --recovery-id) shift; recovery_id="${1:-}" ;;
    --peer-id) shift; peer_id="${1:-}" ;;
    --peer-address) shift; peer_address="${1:-}" ;;
    --confirm) shift; confirmation="${1:-}" ;;
    *) usage; exit 2 ;;
  esac
  shift
done
[[ $EUID -eq 0 && -n "$mode" && "$recovery_id" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$ ]] || { usage; exit 2; }
[[ "$peer_id" =~ ^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$ ]] || { printf 'Peer ID is invalid.\n' >&2; exit 2; }
[[ -z "$peer_address" || "$peer_address" =~ ^tcp://[A-Za-z0-9.:-]+:[0-9]+$ ]] || { printf 'Peer address is invalid.\n' >&2; exit 2; }

if [[ "$mode" == --mark-ingress-active ]]; then
  [[ "$confirmation" == MARK-INGRESS-ACTIVE ]] || { printf 'Marking ingress requires --confirm MARK-INGRESS-ACTIVE.\n' >&2; exit 2; }
  marker=/etc/hosting-control/promotion-state.json
  jq -e --arg id "$recovery_id" '.status == "local-primary" and .recovery_id == $id and .public_ingress_cutover == false' "$marker" >/dev/null
  jq '.public_ingress_cutover = true' "$marker" > "$marker.tmp.$$"
  chmod 644 "$marker.tmp.$$"; mv "$marker.tmp.$$" "$marker"
  printf 'Direct public ingress marked active for recovery %s.\n' "$recovery_id"
  exit 0
fi

args=(--dry-run --recovery-id "$recovery_id")
"$project_dir/scripts/promote-standby.sh" "${args[@]}"
[[ "$mode" == --dry-run ]] && exit 0
[[ "$confirmation" == ACCEPT-FAILBACK-PRIMARY ]] || { printf 'Apply requires --confirm ACCEPT-FAILBACK-PRIMARY.\n' >&2; exit 2; }
former_fence_enabled=0
if systemctl is-enabled hosting-former-primary-fence.timer >/dev/null 2>&1; then
  former_fence_enabled=1
fi
systemctl stop hosting-former-primary-fence.timer hosting-former-primary-fence.service >/dev/null 2>&1 || true
if ! "$project_dir/scripts/promote-standby.sh" --apply --recovery-id "$recovery_id" \
  --confirm PROMOTE-STANDBY --fence-confirm OLD-PRIMARY-FENCED; then
  if (( former_fence_enabled == 1 )); then
    systemctl enable --now hosting-former-primary-fence.timer >/dev/null 2>&1 || true
  fi
  exit 1
fi
sync_args=(--peer-id "$peer_id" --peer-name failback-standby --mode sendonly)
[[ -z "$peer_address" ]] || sync_args+=(--peer-address "$peer_address")
"$project_dir/scripts/configure-sync.sh" "${sync_args[@]}"
"$project_dir/scripts/install-warm-sync-finalizer.sh" --source >/dev/null
"$project_dir/scripts/install-replication-timer.sh" >/dev/null
printf 'Rebuilt host promoted locally at recovery %s. Public ingress is not yet confirmed.\n' "$recovery_id"
