#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: record-primary-fence.sh --primary-server-id ID --method power|network|service --confirm OLD-PRIMARY-FENCED [--expires-minutes 15]

Run this on the standby only after the named primary has actually been fenced.
The receipt is bound to the currently prepared recovery point.
EOF
}

primary_server_id=""
method=""
confirmation=""
expires_minutes=15
receipt=/etc/hosting-control/primary-fence-receipt.json
recovery_marker=/etc/hosting-control/standby-recovery.json

while [ "$#" -gt 0 ]; do
  case "$1" in
    --primary-server-id) shift; primary_server_id="${1:-}" ;;
    --method) shift; method="${1:-}" ;;
    --confirm) shift; confirmation="${1:-}" ;;
    --expires-minutes) shift; expires_minutes="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
case "$primary_server_id" in ''|*[!A-Za-z0-9._-]*) usage; exit 2 ;; esac
case "$method" in power|network|service) ;; *) usage; exit 2 ;; esac
[ "$confirmation" = OLD-PRIMARY-FENCED ] \
  || { printf 'Confirmation must be OLD-PRIMARY-FENCED.\n' >&2; exit 2; }
case "$expires_minutes" in ''|*[!0-9]*) usage; exit 2 ;; esac
[ "$expires_minutes" -ge 1 ] && [ "$expires_minutes" -le 60 ] || { usage; exit 2; }
[ -f "$recovery_marker" ] && [ ! -L "$recovery_marker" ] \
  || { printf 'Prepared standby recovery marker is missing.\n' >&2; exit 1; }
recovery_id="$(jq -er '.app_data_id' "$recovery_marker")"
fenced_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
expires_at="$(date -u -d "+$expires_minutes minutes" +%Y-%m-%dT%H:%M:%SZ)"

install -d -m 700 /etc/hosting-control
temporary="$receipt.tmp.$$"
umask 077
jq -n --arg primary "$primary_server_id" --arg method "$method" \
  --arg recovery "$recovery_id" --arg fenced_at "$fenced_at" --arg expires_at "$expires_at" \
  '{version:1,status:"fenced",primaryServerId:$primary,method:$method,recoveryId:$recovery,fencedAt:$fenced_at,expiresAt:$expires_at}' \
  > "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$receipt"
printf 'Fencing receipt recorded for %s and recovery %s; expires at %s.\n' \
  "$primary_server_id" "$recovery_id" "$expires_at"
