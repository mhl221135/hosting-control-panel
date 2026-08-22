#!/bin/sh

set -eu

usage() {
  printf 'Usage: install-former-primary-fence.sh --peer-health-url HTTPS_URL --peer-server-id ID [--enable]\n' >&2
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
peer_url=""
peer_id=""
enabled=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --peer-health-url) shift; peer_url="${1:-}" ;;
    --peer-server-id) shift; peer_id="${1:-}" ;;
    --enable) enabled=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
printf '%s' "$peer_url" | grep -Eq '^https://[A-Za-z0-9][A-Za-z0-9.-]{0,252}(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]{0,500})?$' \
  || { usage; exit 2; }
case "$peer_id" in ''|*[!A-Za-z0-9._-]*) usage; exit 2 ;; esac

install -d -m 700 /etc/hosting-control
temporary=/etc/hosting-control/former-primary-fence.env.tmp.$$
umask 077
{
  printf "FORMER_PRIMARY_FENCE_ENABLED='%s'\n" "$enabled"
  printf "FORMER_PRIMARY_PEER_HEALTH_URL='%s'\n" "$peer_url"
  printf "FORMER_PRIMARY_PEER_SERVER_ID='%s'\n" "$peer_id"
} > "$temporary"
mv "$temporary" /etc/hosting-control/former-primary-fence.env

cat > /etc/systemd/system/hosting-former-primary-fence.service <<EOF
[Unit]
Description=Fence recovered hosting primary when promoted peer is authoritative
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$project_dir/scripts/fence-former-primary.sh
EOF

cat > /etc/systemd/system/hosting-former-primary-fence.timer <<'EOF'
[Unit]
Description=Check whether the former hosting primary must self-fence

[Timer]
OnBootSec=15s
OnUnitActiveSec=30s
AccuracySec=5s
Unit=hosting-former-primary-fence.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now hosting-former-primary-fence.timer
printf 'Former-primary fence installed; enabled=%s peer=%s. It never auto-unfences.\n' "$enabled" "$peer_id"
