#!/bin/sh

set -eu

usage() {
  printf 'Usage: install-automatic-failover.sh --health-url HTTPS_URL --hosts-file PATH [--enable]\n' >&2
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
health_url=""
hosts_file=""
enabled=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --health-url) shift; health_url="${1:-}" ;;
    --hosts-file) shift; hosts_file="${1:-}" ;;
    --enable) enabled=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done
case "$health_url" in https://*) ;; *) usage; exit 2 ;; esac
case "$hosts_file" in /*) ;; *) usage; exit 2 ;; esac
[ -f "$hosts_file" ] || { printf 'Automatic failover host file is missing.\n' >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }

install -d -m 700 /etc/hosting-control
temporary=/etc/hosting-control/automatic-failover.env.tmp.$$
umask 077
{
  printf "AUTO_FAILOVER_ENABLED='%s'\n" "$enabled"
  printf "AUTO_FAILOVER_FAILURES='6'\n"
  printf "PRIMARY_HEALTH_URL='%s'\n" "$health_url"
  printf "AUTO_FAILOVER_HOSTS_FILE='%s'\n" "$hosts_file"
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
printf 'Automatic failover timer installed; enabled=%s.\n' "$enabled"
