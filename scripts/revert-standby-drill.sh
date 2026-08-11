#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: revert-standby-drill.sh [options]

Options:
  --dry-run            Validate that a promoted standby can be returned to standby
  --apply              Stop the promoted runtime and restore the standby role
  --recovery-id ID     Exact recovery identifier used for the drill
  --confirm TEXT       Required with --apply; must be REVERT-STANDBY-DRILL
  --writes-confirm TEXT
                       Required with --apply; must be NO-PUBLIC-WRITES

This command is only for a read-only failover drill after tunnel ingress has
been rolled back. It must not be used to fail back after production writes.
EOF
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
mode=""
recovery_id=""
confirmation=""
writes_confirmation=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) mode=dry-run ;;
    --apply) mode=apply ;;
    --recovery-id) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; recovery_id="$1" ;;
    --confirm) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; confirmation="$1" ;;
    --writes-confirm) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; writes_confirmation="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
  shift
done

[ -f "$env_file" ] || { printf 'Environment file does not exist: %s\n' "$env_file" >&2; exit 1; }
[ -n "$mode" ] || { printf 'Select --dry-run or --apply.\n' >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { printf 'Run this command as root.\n' >&2; exit 1; }

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
role_marker="$machine_state/role.json"
promotion_marker="$machine_state/promotion-state.json"
cutover_marker="$machine_state/tunnel-cutover.json"

case "$machine_state" in /*) ;; *) printf 'Machine state path must be absolute.\n' >&2; exit 2 ;; esac
for command in jq flock docker awk grep; do
  command -v "$command" >/dev/null 2>&1 || { printf 'Required command is missing: %s\n' "$command" >&2; exit 1; }
done

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  printf 'Docker Compose is required.\n' >&2
  exit 1
fi

[ -f "$role_marker" ] && [ -f "$promotion_marker" ] \
  || { printf 'Active promoted-standby markers are missing.\n' >&2; exit 1; }
jq -e '.version == 1 and .role == "primary" and (.server_id | type == "string") and (.server_id | length > 0)' \
  "$role_marker" >/dev/null || { printf 'This machine is not a promoted primary.\n' >&2; exit 1; }
jq -e '.version == 1 and .status == "local-primary" and .previous_role == "standby" and
  .public_ingress_cutover == false and (.recovery_id | type == "string")' \
  "$promotion_marker" >/dev/null \
  || { printf 'Promotion state is invalid or public ingress is still active. Roll back ingress first.\n' >&2; exit 1; }

promoted_recovery="$(jq -r .recovery_id "$promotion_marker")"
case "$promoted_recovery" in ????-??-??T??-??-??Z) ;; *) printf 'Promotion recovery identifier is invalid.\n' >&2; exit 1 ;; esac
[ -z "$recovery_id" ] || [ "$recovery_id" = "$promoted_recovery" ] \
  || { printf 'Requested recovery does not match promoted recovery %s.\n' "$promoted_recovery" >&2; exit 1; }
if [ -f "$cutover_marker" ]; then
  jq -e '.version == 1 and .status == "rolled-back"' "$cutover_marker" >/dev/null \
    || { printf 'Tunnel cutover state is not rolled back.\n' >&2; exit 1; }
fi

compose config --quiet
printf 'Read-only drill recovery %s can be returned to standby.\n' "$promoted_recovery"
if [ "$mode" = dry-run ]; then
  exit 0
fi

[ "$confirmation" = REVERT-STANDBY-DRILL ] \
  || { printf 'Apply requires --confirm REVERT-STANDBY-DRILL.\n' >&2; exit 2; }
[ "$writes_confirmation" = NO-PUBLIC-WRITES ] \
  || { printf 'Apply requires --writes-confirm NO-PUBLIC-WRITES.\n' >&2; exit 2; }
[ "$recovery_id" = "$promoted_recovery" ] \
  || { printf 'Apply requires --recovery-id %s.\n' "$promoted_recovery" >&2; exit 2; }

mkdir -p /run/hosting-backup-receiver
exec 9>"/run/hosting-backup-receiver/lock"
flock -n 9 || { printf 'Backup reception or another standby operation is active.\n' >&2; exit 1; }

compose stop hosting-npm hosting-phpmyadmin hosting-files hosting-billing hosting-nginx hosting-php-fpm hosting-redis hosting-db
unexpected="$(docker ps --format '{{.Names}}' | awk '/^hosting-/ && $0 !~ /^(hosting-agent|hosting-ui|hosting-cloudflared)$/ { print }')"
[ -z "$unexpected" ] || { printf 'Writable hosting containers are still running: %s\n' "$unexpected" >&2; exit 1; }

temporary="$machine_state/role.json.drill.$$"
server_id="$(jq -r .server_id "$role_marker")"
jq -n --arg server_id "$server_id" '{version:1,role:"standby",server_id:$server_id}' > "$temporary"
chmod 644 "$temporary"
mv "$temporary" "$role_marker"

archive="$machine_state/promotion-state.last-drill.json"
jq --arg reverted_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '. + {drill_reverted_at:$reverted_at}' "$promotion_marker" > "$archive.tmp.$$"
chmod 600 "$archive.tmp.$$"
mv "$archive.tmp.$$" "$archive"
rm -f "$promotion_marker"

if [ -f "$cutover_marker" ]; then
  cutover_archive="$machine_state/tunnel-cutover.last-drill.json"
  jq --arg archived_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '. + {drill_archived_at:$archived_at}' "$cutover_marker" > "$cutover_archive.tmp.$$"
  chmod 600 "$cutover_archive.tmp.$$"
  mv "$cutover_archive.tmp.$$" "$cutover_archive"
  rm -f "$cutover_marker"
fi

if [ "$(env_value HOSTING_TUNNEL_ENABLED)" = true ]; then
  compose up -d hosting-agent hosting-ui hosting-cloudflared
else
  compose up -d hosting-agent hosting-ui
fi
docker restart hosting-ui >/dev/null
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now hosting-backup-receiver.timer >/dev/null 2>&1 || true
fi
printf 'Read-only drill reverted. The machine is fenced as standby and public ingress remains rolled back.\n'
