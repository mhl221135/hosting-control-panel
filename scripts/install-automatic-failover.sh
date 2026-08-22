#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: install-automatic-failover.sh --health-url HTTPS_URL --hosts-file PATH [options]

Options:
  --enable                    Enable outage monitoring
  --mode monitor|activate     Monitor only (default) or activate after fencing
  --primary-server-id ID      Required for activate mode
  --primary-sync-device-id ID Exact Syncthing device ID of the primary
  --auto-qualify-hosts         Refresh Cloudflare-ready hosts after preparation
  --fence-receipt PATH        Root-owned fencing receipt path
  --panel-state-file PATH     Sanitized status file visible to hosting-ui
  --fence-policy POLICY      receipt (default) or unreachable
  --unreachable-grace SEC    180-3600 seconds (default: 300)
  --max-recovery-age SEC     1800-86400 seconds (default: 7200)
  --risk-confirm TEXT        Required for unreachable policy
EOF
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
health_url=""
hosts_file=""
enabled=false
mode=monitor
primary_server_id=""
primary_sync_device_id=""
auto_qualify_hosts=false
fence_receipt=/etc/hosting-control/primary-fence-receipt.json
panel_state_file="$project_dir/../app-data/ui-manager/automatic-failover-state.json"
fence_policy=receipt
unreachable_grace=300
max_recovery_age=7200
risk_confirmation=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --health-url) shift; health_url="${1:-}" ;;
    --hosts-file) shift; hosts_file="${1:-}" ;;
    --enable) enabled=true ;;
    --mode) shift; mode="${1:-}" ;;
    --primary-server-id) shift; primary_server_id="${1:-}" ;;
    --primary-sync-device-id) shift; primary_sync_device_id="${1:-}" ;;
    --auto-qualify-hosts) auto_qualify_hosts=true ;;
    --fence-receipt) shift; fence_receipt="${1:-}" ;;
    --panel-state-file) shift; panel_state_file="${1:-}" ;;
    --fence-policy) shift; fence_policy="${1:-}" ;;
    --unreachable-grace) shift; unreachable_grace="${1:-}" ;;
    --max-recovery-age) shift; max_recovery_age="${1:-}" ;;
    --risk-confirm) shift; risk_confirmation="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done
case "$health_url" in https://*) ;; *) usage; exit 2 ;; esac
case "$hosts_file" in /*) ;; *) usage; exit 2 ;; esac
[ -f "$hosts_file" ] || { printf 'Automatic failover host file is missing.\n' >&2; exit 1; }
case "$mode" in monitor|activate) ;; *) usage; exit 2 ;; esac
case "$fence_receipt" in /*) ;; *) usage; exit 2 ;; esac
case "$panel_state_file" in /*) ;; *) usage; exit 2 ;; esac
case "$fence_policy" in receipt|unreachable) ;; *) usage; exit 2 ;; esac
case "$unreachable_grace" in ''|*[!0-9]*) usage; exit 2 ;; esac
[ "$unreachable_grace" -ge 180 ] && [ "$unreachable_grace" -le 3600 ] || { usage; exit 2; }
case "$max_recovery_age" in ''|*[!0-9]*) usage; exit 2 ;; esac
[ "$max_recovery_age" -ge 1800 ] && [ "$max_recovery_age" -le 86400 ] || { usage; exit 2; }
if [ "$fence_policy" = unreachable ] && [ "$risk_confirmation" != I-ACCEPT-SPLIT-BRAIN-RISK ]; then
  printf 'Unreachable policy requires --risk-confirm I-ACCEPT-SPLIT-BRAIN-RISK.\n' >&2
  exit 2
fi
if [ "$mode" = activate ]; then
  case "$primary_server_id" in ''|*[!A-Za-z0-9._-]*) usage; exit 2 ;; esac
  case "$primary_sync_device_id" in
    ???????-???????-???????-???????-???????-???????-???????-???????) ;;
    *) printf 'Activate mode requires the exact primary Syncthing device ID.\n' >&2; exit 2 ;;
  esac
fi
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }

install -d -m 700 /etc/hosting-control
temporary=/etc/hosting-control/automatic-failover.env.tmp.$$
umask 077
{
  printf "AUTO_FAILOVER_ENABLED='%s'\n" "$enabled"
  printf "AUTO_FAILOVER_MODE='%s'\n" "$mode"
  printf "AUTO_FAILOVER_FAILURES='6'\n"
  printf "PRIMARY_HEALTH_URL='%s'\n" "$health_url"
  printf "AUTO_FAILOVER_HOSTS_FILE='%s'\n" "$hosts_file"
  printf "AUTO_FAILOVER_PRIMARY_SERVER_ID='%s'\n" "$primary_server_id"
  printf "AUTO_FAILOVER_PRIMARY_SYNC_DEVICE_ID='%s'\n" "$primary_sync_device_id"
  printf "AUTO_FAILOVER_AUTO_QUALIFY_HOSTS='%s'\n" "$auto_qualify_hosts"
  printf "AUTO_FAILOVER_FENCE_RECEIPT='%s'\n" "$fence_receipt"
  printf "AUTO_FAILOVER_FENCE_MAX_AGE_SECONDS='900'\n"
  printf "AUTO_FAILOVER_FENCE_POLICY='%s'\n" "$fence_policy"
  printf "AUTO_FAILOVER_UNREACHABLE_GRACE_SECONDS='%s'\n" "$unreachable_grace"
  printf "AUTO_FAILOVER_MAX_RECOVERY_AGE_SECONDS='%s'\n" "$max_recovery_age"
  printf "AUTO_FAILOVER_UNREACHABLE_RISK_ACCEPTED='%s'\n" "$risk_confirmation"
  printf "AUTO_FAILOVER_PUBLIC_STATE_FILE='%s'\n" "$panel_state_file"
} > "$temporary"
mv "$temporary" /etc/hosting-control/automatic-failover.env

cat > /etc/systemd/system/hosting-automatic-failover.service <<EOF
[Unit]
Description=Guarded hosting standby automatic failover check
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$project_dir/scripts/automatic-failover.sh
EOF

cat > /etc/systemd/system/hosting-automatic-failover.timer <<'EOF'
[Unit]
Description=Check primary hosting health every 30 seconds

[Timer]
OnBootSec=2m
OnUnitActiveSec=30s
AccuracySec=5s
Unit=hosting-automatic-failover.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now hosting-automatic-failover.timer
printf 'Automatic failover timer installed; enabled=%s mode=%s.\n' "$enabled" "$mode"
