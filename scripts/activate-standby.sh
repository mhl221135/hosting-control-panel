#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: activate-standby.sh --preview|--apply [options]

Options:
  --root PATH            Standby installation root
  --hosts-file PATH      One production hostname per line
  --api-token-file PATH  Root-readable Cloudflare management token
  --recovery-id ID       Exact prepared recovery identifier
  --confirm TEXT         Required with --apply; must be ACTIVATE-STANDBY
  --fence-confirm TEXT   Required with --apply; must be OLD-PRIMARY-FENCED

Preview validates both local promotion and the selected Cloudflare changes.
Apply promotes the prepared standby first, then switches only the listed hosts.
It never decides that the old primary is fenced; the operator must establish
and explicitly confirm fencing before apply.
EOF
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
mode=""
root=""
hosts_file=""
api_token_file=""
recovery_id=""
confirmation=""
fence_confirmation=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --preview|--apply) mode="$1" ;;
    --root) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; root="$1" ;;
    --hosts-file) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; hosts_file="$1" ;;
    --api-token-file) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; api_token_file="$1" ;;
    --recovery-id) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; recovery_id="$1" ;;
    --confirm) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; confirmation="$1" ;;
    --fence-confirm) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; fence_confirmation="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { printf 'Run this command as root.\n' >&2; exit 1; }
[ -n "$mode" ] || { usage; exit 2; }
[ -n "$hosts_file" ] || { printf '%s requires --hosts-file.\n' "$mode" >&2; exit 2; }
[ -n "$api_token_file" ] || { printf '%s requires --api-token-file.\n' "$mode" >&2; exit 2; }
case "$api_token_file" in /*) ;; *) printf 'API token file must be an absolute path.\n' >&2; exit 2 ;; esac
[ -f "$api_token_file" ] && [ ! -L "$api_token_file" ] \
  || { printf 'API token file must be a regular, non-symlink file.\n' >&2; exit 1; }

token_mode="$(stat -c '%a' "$api_token_file" 2>/dev/null || true)"
[ "$token_mode" = 600 ] || { printf 'API token file must have mode 600.\n' >&2; exit 1; }
token_owner="$(stat -c '%u' "$api_token_file" 2>/dev/null || true)"
[ "$token_owner" = 0 ] || { printf 'API token file must be owned by root.\n' >&2; exit 1; }
CLOUDFLARE_TUNNEL_API_TOKEN="$(cat "$api_token_file")"
[ -n "$CLOUDFLARE_TUNNEL_API_TOKEN" ] || { printf 'API token file is empty.\n' >&2; exit 1; }

set --
[ -z "$root" ] || set -- "$@" --root "$root"
[ -z "$recovery_id" ] || set -- "$@" --recovery-id "$recovery_id"

if [ "$mode" = --preview ]; then
  "$project_dir/scripts/promote-standby.sh" --dry-run "$@"
  export CLOUDFLARE_TUNNEL_API_TOKEN
  "$project_dir/scripts/tunnel-cutover.sh" --preview --hosts-file "$hosts_file"
  printf 'Standby activation preview passed. No local role, service, DNS, or tunnel route changed.\n'
  exit 0
fi

[ "$confirmation" = ACTIVATE-STANDBY ] \
  || { printf 'Apply requires --confirm ACTIVATE-STANDBY.\n' >&2; exit 2; }
[ "$fence_confirmation" = OLD-PRIMARY-FENCED ] \
  || { printf 'Apply requires --fence-confirm OLD-PRIMARY-FENCED.\n' >&2; exit 2; }
[ -n "$recovery_id" ] \
  || { printf 'Apply requires the exact --recovery-id shown by preview.\n' >&2; exit 2; }

"$project_dir/scripts/promote-standby.sh" --apply "$@" \
  --confirm PROMOTE-STANDBY --fence-confirm OLD-PRIMARY-FENCED

export CLOUDFLARE_TUNNEL_API_TOKEN
if ! "$project_dir/scripts/tunnel-cutover.sh" --apply --hosts-file "$hosts_file" \
  --confirm SWITCH-TUNNEL-INGRESS; then
  printf 'Local promotion succeeded but public ingress did not. The host remains an isolated primary for inspection.\n' >&2
  printf 'Do not restart the old primary. Correct ingress or use drill reversion only if no public writes occurred.\n' >&2
  exit 1
fi

printf 'Standby activation completed for the explicitly selected hostnames.\n'
