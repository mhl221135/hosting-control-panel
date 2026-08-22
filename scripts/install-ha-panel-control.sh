#!/bin/sh
set -eu

usage() { printf 'Usage: install-ha-panel-control.sh [--ui-data-dir PATH]\n' >&2; }
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
ui_data_dir="$project_dir/../app-data/ui-manager"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ui-data-dir) [ "$#" -ge 2 ] || { usage; exit 2; }; ui_data_dir=$2; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done
case "$ui_data_dir" in /*) ;; *) printf 'UI data directory must be absolute.\n' >&2; exit 2 ;; esac
mkdir -p /etc/hosting-control "$ui_data_dir"
temporary=/etc/hosting-control/ha-panel-control.env.tmp.$$
printf "HA_PANEL_DATA_DIR='%s'\n" "$(printf %s "$ui_data_dir" | sed "s/'/'\\\\''/g")" > "$temporary"
chmod 0600 "$temporary"
mv "$temporary" /etc/hosting-control/ha-panel-control.env

cat > /etc/systemd/system/hosting-ha-panel-control.service <<EOF
[Unit]
Description=Process a bounded Hosting Control HA request
After=docker.service network-online.target

[Service]
Type=oneshot
ExecStart=$project_dir/scripts/process-ha-panel-control.sh
TimeoutStartSec=infinity
EOF
cat > /etc/systemd/system/hosting-ha-panel-control.timer <<'EOF'
[Unit]
Description=Poll for bounded Hosting Control HA requests

[Timer]
OnBootSec=15s
OnUnitActiveSec=15s
Persistent=true
Unit=hosting-ha-panel-control.service

[Install]
WantedBy=timers.target
EOF
chmod 0755 "$project_dir/scripts/process-ha-panel-control.sh"
systemctl daemon-reload
systemctl enable --now hosting-ha-panel-control.timer
printf 'HA panel control installed for %s.\n' "$ui_data_dir"
