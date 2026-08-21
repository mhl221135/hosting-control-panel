#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: install-automatic-failover.sh --health-url HTTPS_URL --hosts-file PATH [options]

Options:
  --enable                    Enable outage monitoring
  --mode monitor|activate     Monitor only (default) or activate after fencing
  --primary-server-id ID      Required for activate mode
  --fence-receipt PATH        Root-owned fencing receipt path
EOF
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
health_url=""
hosts_file=""
enabled=false
mode=monitor
primary_server_id=""
fence_receipt=/etc/hosting-control/primary-fence-receipt.json
while [ "$#" -gt 0 ]; do
  case "$1" in
    --health-url) shift; health_url="${1:-}" ;;
    --hosts-file) shift; hosts_file="${1:-}" ;;
    --enable) enabled=true ;;
    --mode) shift; mode="${1:-}" ;;
    --primary-server-id) shift; primary_server_id="${1:-}" ;;
    --fence-receipt) shift; fence_receipt="${1:-}" ;;
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
if [ "$mode" = activate ]; then
  case "$primary_server_id" in ''|*[!A-Za-z0-9._-]*) usage; exit 2 ;; esac
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
  printf "AUTO_FAILOVER_FENCE_RECEIPT='%s'\n" "$fence_receipt"
  printf "AUTO_FAILOVER_FENCE_MAX_AGE_SECONDS='900'\n"
  printf "AUTO_FAILOVER_PUBLIC_STATE_FILE='%s'\n" "$project_dir/../app-data/ui-manager/automatic-failover-state.json"
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
