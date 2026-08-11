#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: tunnel-cutover.sh --preview|--apply|--rollback [options]

Options:
  --hosts-file PATH  One hostname per line (required except rollback)
  --confirm TEXT     Typed confirmation required for apply or rollback

Export CLOUDFLARE_TUNNEL_API_TOKEN before running. The token requires
Cloudflare Tunnel Edit, Zone Read, and DNS Edit for the selected zones.
EOF
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
mode=""
hosts_file=""
confirmation=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --preview|--apply|--rollback) mode="$1" ;;
    --hosts-file) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; hosts_file="$1" ;;
    --confirm) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; confirmation="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
  shift
done

[ -f "$env_file" ] || { printf 'Environment file does not exist: %s\n' "$env_file" >&2; exit 1; }
[ -n "$mode" ] || { usage; exit 2; }
[ -n "${CLOUDFLARE_TUNNEL_API_TOKEN:-}" ] \
  || { printf 'CLOUDFLARE_TUNNEL_API_TOKEN is required.\n' >&2; exit 1; }

env_value() {
  awk -v key="$1" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
      if (value ~ /^".*"$/ || value ~ /^'"'"'.*'"'"'$/) value = substr(value, 2, length(value) - 2)
      print value
      exit
    }
  ' "$env_file"
}

machine_state="$(env_value HOSTING_MACHINE_STATE_DIR)"
machine_state="${machine_state:-/etc/hosting-control}"
tunnel_token_file="$(env_value HOSTING_TUNNEL_TOKEN_FILE)"
tunnel_token_file="${tunnel_token_file:-/etc/hosting-control/cloudflared-hosting.token}"

case "$machine_state" in /*) ;; *) printf 'Machine state path must be absolute.\n' >&2; exit 2 ;; esac
case "$tunnel_token_file" in /*) ;; *) printf 'Tunnel token path must be absolute.\n' >&2; exit 2 ;; esac
[ -d "$machine_state" ] || { printf 'Machine state directory is missing.\n' >&2; exit 1; }
[ -f "$tunnel_token_file" ] || { printf 'Tunnel connector token file is missing.\n' >&2; exit 1; }

if [ "$mode" != --rollback ]; then
  [ -n "$hosts_file" ] || { printf '%s requires --hosts-file.\n' "$mode" >&2; exit 2; }
  case "$hosts_file" in /*) ;; *) hosts_file="$(CDPATH='' cd -- "$(dirname -- "$hosts_file")" && pwd)/$(basename -- "$hosts_file")" ;; esac
  [ -f "$hosts_file" ] || { printf 'Hosts file does not exist.\n' >&2; exit 1; }
fi

image="$(docker inspect hosting-ui --format '{{.Config.Image}}' 2>/dev/null || true)"
[ -n "$image" ] || { printf 'The hosting-ui image could not be identified.\n' >&2; exit 1; }

identity="$(docker run --rm \
  --user 65532:65532 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  -v "$tunnel_token_file:/run/secrets/hosting-tunnel-token:ro" \
  "$image" node -e '
    const fs = require("fs");
    const { decodeTunnelToken } = require("/app/lib/tunnel-cutover");
    const value = decodeTunnelToken(fs.readFileSync("/run/secrets/hosting-tunnel-token", "utf8"));
    process.stdout.write(`${value.accountId} ${value.tunnelId}`);
  ')" || { printf 'Tunnel connector identity could not be read.\n' >&2; exit 1; }
set -- $identity
[ "$#" -eq 2 ] || { printf 'Tunnel connector identity is invalid.\n' >&2; exit 1; }
account_id="$1"
tunnel_id="$2"

set -- "$mode"
if [ -n "$hosts_file" ]; then set -- "$@" --hosts-file /run/hosting-cutover/hosts.txt; fi
if [ -n "$confirmation" ]; then set -- "$@" --confirm "$confirmation"; fi

docker run --rm \
  --user 0:0 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  -e CLOUDFLARE_TUNNEL_API_TOKEN \
  -e CLOUDFLARE_ACCOUNT_ID="$account_id" \
  -e CLOUDFLARED_TUNNEL_ID="$tunnel_id" \
  -e HOSTING_MACHINE_STATE_DIR=/run/hosting-machine \
  -v "$machine_state:/run/hosting-machine:rw" \
  -v "${hosts_file:-/dev/null}:/run/hosting-cutover/hosts.txt:ro" \
  "$image" node /app/cli/tunnel-cutover.js "$@"
