#!/bin/sh

set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
[ -f "$project_dir/.env" ] || { printf 'Missing .env file.\n' >&2; exit 1; }

cat > /etc/systemd/system/hosting-database-replication.service <<EOF
[Unit]
Description=Create an atomic hosting database recovery point
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
ExecStart=$project_dir/scripts/create-replication-dump.sh
EOF

cat > /etc/systemd/system/hosting-database-replication.timer <<'EOF'
[Unit]
Description=Create hourly hosting database recovery points

[Timer]
OnActiveSec=10m
OnUnitActiveSec=1h
RandomizedDelaySec=5m
Persistent=true
Unit=hosting-database-replication.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
role="$(jq -r '.role // empty' /etc/hosting-control/role.json 2>/dev/null || true)"
if [ "$role" = primary ]; then
  systemctl enable --now hosting-database-replication.timer
  printf 'Installed and enabled hourly database replication timer.\n'
else
  systemctl disable --now hosting-database-replication.timer >/dev/null 2>&1 || true
  printf 'Installed database replication timer disabled for standby role.\n'
fi
