#!/bin/sh
set -eu
usage() { printf 'Usage: install-witness-primary-lease.sh --url HTTPS_URL --token-file PATH\n' >&2; }
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
url= token_file=
while [ "$#" -gt 0 ]; do case "$1" in
  --url) shift; url=${1:-} ;; --token-file) shift; token_file=${1:-} ;; *) usage; exit 2 ;;
esac; shift; done
case "$url" in https://*/v1/lease) ;; *) usage; exit 2 ;; esac
case "$token_file" in /*) ;; *) usage; exit 2 ;; esac
[ -f "$token_file" ] && [ ! -L "$token_file" ] && [ "$(stat -c %u "$token_file")" = 0 ] \
  && [ "$(stat -c %a "$token_file")" = 600 ] || { printf 'Token file must be root-owned mode 600.\n' >&2; exit 1; }
install -d -m 700 /etc/hosting-control
umask 077
temporary=/etc/hosting-control/witness-primary.env.tmp.$$
printf "WITNESS_LEASE_URL='%s'\nWITNESS_PRIMARY_TOKEN_FILE='%s'\n" "$url" "$token_file" > "$temporary"
mv "$temporary" /etc/hosting-control/witness-primary.env
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
chmod 0755 "$project_dir/scripts/witness-primary-lease.js" "$project_dir/scripts/witness-primary-watchdog.sh"
node "$project_dir/scripts/witness-primary-lease.js" \
  || { printf 'Initial witness lease failed; watchdog was not installed.\n' >&2; exit 1; }
cat > /etc/systemd/system/hosting-witness-primary.service <<EOF
[Unit]
Description=Renew independent hosting-primary witness lease
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=$project_dir/scripts/witness-primary-watchdog.sh
EOF
cat > /etc/systemd/system/hosting-witness-primary.timer <<'EOF'
[Unit]
Description=Renew hosting-primary witness lease every 20 seconds
[Timer]
OnBootSec=15s
OnUnitActiveSec=20s
AccuracySec=2s
Unit=hosting-witness-primary.service
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now hosting-witness-primary.timer
printf 'Independent witness primary lease enabled.\n'
