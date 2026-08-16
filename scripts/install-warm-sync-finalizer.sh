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

# Large website trees exceed common distribution defaults. Persist enough
# inotify capacity so Syncthing can detect changes promptly after every boot.
cat > /etc/sysctl.d/90-hosting-syncthing.conf <<'EOF'
fs.inotify.max_user_watches=1048576
fs.inotify.max_user_instances=8192
fs.inotify.max_queued_events=32768
EOF
sysctl --system >/dev/null

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
systemctl enable "$unit.service"
systemctl start --no-block "$unit.service"
if [ "$mode" = --standby ]; then
  cat > /etc/systemd/system/hosting-standby-fence.service <<EOF
[Unit]
Description=Stop writable hosting services when this machine is standby
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStartPre=/bin/sleep 10
ExecStart=$project_dir/scripts/enforce-standby-fence.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable hosting-standby-fence.service
  systemctl restart hosting-standby-fence.service
  cat > /etc/systemd/system/hosting-warm-sync-finalizer.timer <<EOF
[Unit]
Description=Refresh the prepared warm standby
After=hosting-standby-fence.service

[Timer]
OnBootSec=5min
OnUnitInactiveSec=10min
Persistent=true
Unit=hosting-warm-sync-finalizer.service

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now hosting-warm-sync-finalizer.timer
fi
printf 'Warm-sync finalizer installed in %s mode.\n' "$role"
