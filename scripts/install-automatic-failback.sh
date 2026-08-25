#!/bin/sh

set -eu

usage() {
  printf 'Usage: install-automatic-failback.sh [--enable] [--stable-checks N] [--grace SEC] [--retry SEC]\n' >&2
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
enabled=false stable_checks=3 grace=60 retry=900
while [ "$#" -gt 0 ]; do
  case "$1" in
    --enable) enabled=true ;;
    --stable-checks) shift; stable_checks="${1:-}" ;;
    --grace) shift; grace="${1:-}" ;;
    --retry) shift; retry="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
[ -f "$env_file" ] || { printf 'Missing .env file.\n' >&2; exit 1; }

env_value() {
  awk -v key="$1" 'index($0,key "=")==1 {
    value=substr($0,length(key)+2)
    if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) value=substr(value,2,length(value)-2)
    print value; exit
  }' "$env_file"
}
peer_host="$(env_value HA_PEER_SSH_HOST)"
peer_host="${peer_host#root@}"
peer_root="$(env_value HA_PEER_ROOT)"; peer_root="${peer_root:-/media/ssdmount/websites-v2}"
peer_id="$(env_value HA_PEER_SYNC_DEVICE_ID)"
local_id="$(env_value HA_LOCAL_SYNC_DEVICE_ID)"
peer_address="$(env_value HA_PEER_SYNC_ADDRESS)"
local_address="$(env_value HA_LOCAL_SYNC_ADDRESS)"
case "$peer_host" in ''|*[!A-Za-z0-9.-]*) printf 'HA_PEER_SSH_HOST is invalid.\n' >&2; exit 1 ;; esac
case "$peer_root" in /*) ;; *) printf 'HA_PEER_ROOT is invalid.\n' >&2; exit 1 ;; esac
case "$peer_root" in *..*) printf 'HA_PEER_ROOT is invalid.\n' >&2; exit 1 ;; esac
for id in "$peer_id" "$local_id"; do
  case "$id" in ???????-???????-???????-???????-???????-???????-???????-???????) ;; *) printf 'HA Syncthing device IDs are invalid.\n' >&2; exit 1 ;; esac
done
for number in "$stable_checks" "$grace" "$retry"; do case "$number" in ''|*[!0-9]*) usage; exit 2 ;; esac; done
[ "$stable_checks" -ge 2 ] && [ "$stable_checks" -le 20 ] || { usage; exit 2; }
[ "$grace" -ge 60 ] && [ "$grace" -le 3600 ] || { usage; exit 2; }
[ "$retry" -ge 300 ] && [ "$retry" -le 86400 ] || { usage; exit 2; }
token_file=/etc/hosting-control/cloudflare-tunnel-api.token
[ -f "$token_file" ] && [ ! -L "$token_file" ] && [ "$(stat -c %u "$token_file")" = 0 ] && [ "$(stat -c %a "$token_file")" = 600 ] \
  || { printf 'Cloudflare tunnel API token file is unavailable.\n' >&2; exit 1; }

install -d -m 700 /etc/hosting-control
temporary=/etc/hosting-control/automatic-failback.env.tmp.$$
umask 077
{
  printf "AUTO_FAILBACK_ENABLED='%s'\n" "$enabled"
  printf "AUTO_FAILBACK_PEER_HOST='%s'\n" "$peer_host"
  printf "AUTO_FAILBACK_PEER_ROOT='%s'\n" "$peer_root"
  printf "AUTO_FAILBACK_PEER_SYNC_DEVICE_ID='%s'\n" "$peer_id"
  printf "AUTO_FAILBACK_LOCAL_SYNC_DEVICE_ID='%s'\n" "$local_id"
  printf "AUTO_FAILBACK_PEER_SYNC_ADDRESS='%s'\n" "$peer_address"
  printf "AUTO_FAILBACK_LOCAL_SYNC_ADDRESS='%s'\n" "$local_address"
  printf "AUTO_FAILBACK_CLOUDFLARE_TOKEN_FILE='%s'\n" "$token_file"
  printf "AUTO_FAILBACK_STABLE_CHECKS='%s'\n" "$stable_checks"
  printf "AUTO_FAILBACK_GRACE_SECONDS='%s'\n" "$grace"
  printf "AUTO_FAILBACK_RETRY_SECONDS='%s'\n" "$retry"
} > "$temporary"
mv "$temporary" /etc/hosting-control/automatic-failback.env

cat > /etc/systemd/system/hosting-automatic-failback.service <<EOF
[Unit]
Description=Return hosting traffic to the recovered preferred primary
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$project_dir/scripts/automatic-failback.sh
TimeoutStartSec=2h
EOF

cat > /etc/systemd/system/hosting-automatic-failback.timer <<'EOF'
[Unit]
Description=Check whether the preferred hosting primary can be rebuilt

[Timer]
OnBootSec=2m
OnUnitActiveSec=30s
AccuracySec=5s
Unit=hosting-automatic-failback.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now hosting-automatic-failback.timer
printf 'Automatic failback timer installed; enabled=%s checks=%s grace=%ss.\n' "$enabled" "$stable_checks" "$grace"
