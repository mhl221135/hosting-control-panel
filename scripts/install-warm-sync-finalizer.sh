#!/bin/sh

set -eu
usage() { printf 'Usage: install-warm-sync-finalizer.sh --source|--standby\n' >&2; }
mode="${1:-}"
case "$mode" in --source|--standby) ;; *) usage; exit 2 ;; esac
[ "$#" -eq 1 ] || { usage; exit 2; }
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
role="${mode#--}"
unit=hosting-warm-sync-finalizer
cat > "/etc/systemd/system/$unit.service" <<EOF
[Unit]
Description=Complete the initial hosting warm-sync baseline ($role)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$project_dir/scripts/finalize-warm-sync.sh $mode
Restart=on-failure
RestartSec=60
TimeoutStartSec=infinity

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$unit.service"
printf 'Warm-sync finalizer installed in %s mode.\n' "$role"
