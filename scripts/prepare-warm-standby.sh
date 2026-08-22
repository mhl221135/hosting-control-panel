#!/bin/sh

set -eu

usage() {
  printf 'Usage: prepare-warm-standby.sh --dry-run|--apply [--confirm PREPARE-WARM-STANDBY]\n' >&2
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
mode=""
confirmation=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run|--apply) mode="$1" ;;
    --confirm) shift; confirmation="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done
[ -f "$env_file" ] || { printf 'Missing .env file.\n' >&2; exit 1; }
[ -n "$mode" ] || { usage; exit 2; }
[ "$mode" != --apply ] || [ "$confirmation" = PREPARE-WARM-STANDBY ] \
  || { printf 'Apply requires --confirm PREPARE-WARM-STANDBY.\n' >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }

env_value() {
  awk -v key="$1" 'index($0,key "=")==1 {
    value=substr($0,length(key)+2)
    if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) value=substr(value,2,length(value)-2)
    print value; exit
  }' "$env_file"
}
root="$(env_value HOSTING_ROOT)"
root="${root:-/media/ssdmount/websites-v2}"
machine_state="$(env_value HOSTING_MACHINE_STATE_DIR)"
machine_state="${machine_state:-/etc/hosting-control}"
role_marker="$machine_state/role.json"
sites_map="$root/app-data/configs/nginx/conf.d/sites.map"

jq -e '.version == 1 and .role == "standby" and (.server_id | type == "string")' "$role_marker" >/dev/null \
  || { printf 'This command is restricted to the machine-local standby.\n' >&2; exit 1; }
[ -f "$sites_map" ] || { printf 'Synchronized sites.map is missing.\n' >&2; exit 1; }
"$project_dir/scripts/check-sync-ready.sh" --allow-small-website-lag
database_recovery_id="$("$project_dir/scripts/restore-replication-dump.sh" --verify --root "$root")"

source_release="$(cat "$project_dir/.source-release" 2>/dev/null || true)"
[ -n "$source_release" ] || { printf 'Source release is missing.\n' >&2; exit 1; }
stage="$(mktemp -d "$machine_state/.warm-prepare.XXXXXX")"
trap 'rm -rf "$stage"' EXIT HUP INT TERM
candidates="$stage/failover-hosts.candidates.txt"
"$project_dir/scripts/generate-failover-hosts.sh" \
  --sites-map "$sites_map" --websites-root "$root/websites" --output "$candidates"

site_count="$(awk '
  /^map[[:space:]]+\$host[[:space:]]+\$site_root[[:space:]]*\{/ { inside=1; next }
  inside && /^[[:space:]]*}/ { inside=0; next }
  inside {
    line=$0; sub(/^[[:space:]]+/, "", line); sub(/;[[:space:]]*$/, "", line)
    split(line, field, /[[:space:]]+/)
    if (field[1] != "default" && field[2] ~ /^\/var\/www\/[A-Za-z0-9._-]+$/) print field[2]
  }
' "$sites_map" | LC_ALL=C sort -u | wc -l | tr -d ' ')"
case "$site_count" in ''|*[!0-9]*) printf 'Site count is invalid.\n' >&2; exit 1 ;; esac
[ "$site_count" -gt 0 ] || { printf 'No synchronized websites were found.\n' >&2; exit 1; }
candidate_count="$(wc -l < "$candidates" | tr -d ' ')"
printf 'Warm recovery point: database %s, %s sites, %s hostnames, source %s.\n' \
  "$database_recovery_id" "$site_count" "$candidate_count" "$source_release"
[ "$mode" = --apply ] || { printf 'Warm standby preparation dry run passed.\n'; exit 0; }

candidate_sha="$(sha256sum "$candidates" | awk '{print $1}')"
generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n --arg generated_at "$generated_at" --arg recovery_id "$database_recovery_id" \
  --arg source_release "$source_release" --arg sha256 "$candidate_sha" --argjson count "$candidate_count" \
  '{version:1,generated_at:$generated_at,recovery_id:$recovery_id,source_release:$source_release,
    sha256:$sha256,count:$count}' > "$stage/failover-hosts.candidates.json"
jq -n --arg prepared_at "$generated_at" --arg app_data_id "$database_recovery_id" \
  --arg database_recovery_id "$database_recovery_id" --arg source_release "$source_release" \
  --argjson site_count "$site_count" \
  '{version:1,mode:"warm-sync",prepared_at:$prepared_at,app_data_id:$app_data_id,
    database_recovery_id:$database_recovery_id,site_count:$site_count,source_release:$source_release}' \
  > "$stage/standby-recovery.json"
chmod 600 "$stage"/*
mv "$candidates" "$machine_state/failover-hosts.candidates.txt"
mv "$stage/failover-hosts.candidates.json" "$machine_state/failover-hosts.candidates.json"
mv "$stage/standby-recovery.json" "$machine_state/standby-recovery.json"
trap - EXIT HUP INT TERM
rmdir "$stage"
automatic_config="$machine_state/automatic-failover.env"
if [ -e "$automatic_config" ]; then
  [ -f "$automatic_config" ] && [ ! -L "$automatic_config" ] \
    && [ "$(stat -c '%u' "$automatic_config" 2>/dev/null || true)" = 0 ] \
    && [ "$(stat -c '%a' "$automatic_config" 2>/dev/null || true)" = 600 ] \
    || { printf 'Automatic failover configuration must be root-owned mode 600.\n' >&2; exit 1; }
  # shellcheck disable=SC1090
  . "$automatic_config"
  if [ "${AUTO_FAILOVER_AUTO_QUALIFY_HOSTS:-false}" = true ]; then
    "$project_dir/scripts/qualify-failover-hosts.sh" --apply --skip-if-current \
      --candidates "$machine_state/failover-hosts.candidates.txt" \
      --output "${AUTO_FAILOVER_HOSTS_FILE:-$machine_state/failover-hosts.auto.txt}" \
      --api-token-file "$machine_state/cloudflare-tunnel-api.token" \
      --recovery-id "$database_recovery_id" --confirm ACCEPT-QUALIFIED-FAILOVER-HOSTS
  fi
fi
printf 'Warm standby prepared at synchronized database recovery point %s. No website files, databases, roles, DNS, or services were changed.\n' "$database_recovery_id"
