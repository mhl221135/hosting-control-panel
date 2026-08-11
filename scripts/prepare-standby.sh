#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: prepare-standby.sh [options]

Options:
  --root PATH       Standby installation root (default: HOSTING_ROOT from .env)
  --backups PATH    Received backups root (default: BACKUPS_DIR from .env)
  --dry-run         Verify and report the newest recovery sets without restoring
  --apply           Restore the selected sets into the fenced standby
  --confirm TEXT    Required with --apply; must be PREPARE-STANDBY
EOF
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
root=""
backups=""
mode=""
confirmation=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; root="$1" ;;
    --backups) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; backups="$1" ;;
    --dry-run) mode=dry-run ;;
    --apply) mode=apply ;;
    --confirm) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; confirmation="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
  shift
done

[ -f "$env_file" ] || { printf 'Environment file does not exist: %s\n' "$env_file" >&2; exit 1; }
[ -n "$mode" ] || { printf 'Select --dry-run or --apply.\n' >&2; exit 2; }
[ "$mode" != apply ] || [ "$confirmation" = PREPARE-STANDBY ] \
  || { printf 'Apply requires --confirm PREPARE-STANDBY.\n' >&2; exit 2; }
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

root="${root:-$(env_value HOSTING_ROOT)}"
root="${root:-/media/ssdmount/websites-v2}"
backups="${backups:-$(env_value BACKUPS_DIR)}"
backups="${backups:-$root/backups}"
machine_state="$(env_value HOSTING_MACHINE_STATE_DIR)"
machine_state="${machine_state:-/etc/hosting-control}"
role_marker="$machine_state/role.json"

case "$root" in /*) ;; *) printf 'Root must be an absolute path.\n' >&2; exit 2 ;; esac
case "$backups" in /*) ;; *) printf 'Backups must be an absolute path.\n' >&2; exit 2 ;; esac
[ -d "$root" ] && [ -d "$backups" ] || { printf 'Root or backups directory is missing.\n' >&2; exit 1; }
[ -f "$role_marker" ] || { printf 'Machine role marker is missing.\n' >&2; exit 1; }
jq -e '.version == 1 and .role == "standby" and (.server_id | type == "string")' "$role_marker" >/dev/null \
  || { printf 'This command is restricted to a machine-local standby role.\n' >&2; exit 1; }

for command in jq sha256sum gzip tar awk sort find flock docker; do
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

start_control_services() {
  if [ "$(env_value HOSTING_TUNNEL_ENABLED)" = true ]; then
    compose up -d hosting-agent hosting-ui hosting-cloudflared
  else
    compose up -d hosting-agent hosting-ui
  fi
}

latest_set() {
  find "$backups/$1" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??-??-??Z' -print 2>/dev/null | sort -r | sed -n '1p'
}

latest_site_set_at_or_before() {
  group="$1"
  cutoff="$2"
  find "$backups/$group" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??-??-??Z' -print 2>/dev/null \
    | sort -r \
    | while IFS= read -r candidate; do
        completed="$(jq -r '.completedAt // empty' "$candidate/manifest.json" 2>/dev/null || true)"
        if [ -n "$completed" ] && awk -v completed="$completed" -v cutoff="$cutoff" 'BEGIN { exit !(completed <= cutoff) }'; then
          printf '%s\n' "$candidate"
          break
        fi
      done
}

verify_artifact() {
  directory="$1"
  artifact="$2"
  manifest="$directory/manifest.json"
  expected_size="$(jq -er --arg file "$artifact" '.artifacts[$file].size' "$manifest")"
  expected_sha="$(jq -er --arg file "$artifact" '.artifacts[$file].sha256' "$manifest")"
  actual_size="$(wc -c < "$directory/$artifact" | tr -d ' ')"
  [ "$actual_size" = "$expected_size" ] || { printf 'Size mismatch: %s\n' "$directory/$artifact" >&2; return 1; }
  actual_sha="$(sha256sum "$directory/$artifact" | awk '{print $1}')"
  [ "$actual_sha" = "$expected_sha" ] || { printf 'Checksum mismatch: %s\n' "$directory/$artifact" >&2; return 1; }
}

verify_app_data() {
  directory="$1"
  id="${directory##*/}"
  jq -e --arg id "$id" '.version == 2 and .type == "app-data" and .id == $id and (.artifacts | type == "object")' \
    "$directory/manifest.json" >/dev/null
  verify_artifact "$directory" app-data.tar.gz
  verify_artifact "$directory" databases.sql.gz
  tar -tzf "$directory/app-data.tar.gz" | awk '
    /^\// { exit 1 }
    /(^|\/)\.\.($|\/)/ { exit 1 }
    { count++ }
    END { if (count == 0) exit 1 }
  '
  gzip -t "$directory/databases.sql.gz"
}

verify_site() {
  directory="$1"
  id="${directory##*/}"
  manifest="$directory/manifest.json"
  jq -e --arg id "$id" '.version == 2 and .type == "site" and .id == $id and (.domain | type == "string") and (.websitePath | type == "string") and (.artifacts | type == "object")' \
    "$manifest" >/dev/null
  website_path="$(jq -r .websitePath "$manifest")"
  case "$website_path" in ''|/*|*..*) printf 'Unsafe website path: %s\n' "$website_path" >&2; return 1 ;; esac
  verify_artifact "$directory" website.tar.gz
  tar -tzf "$directory/website.tar.gz" | awk -v root="$website_path" '
    /^\// { exit 1 }
    /(^|\/)\.\.($|\/)/ { exit 1 }
    { if ($0 != root && index($0, root "/") != 1) exit 1; count++ }
    END { if (count == 0) exit 1 }
  '
}

app_set="$(latest_set app-data)"
[ -n "$app_set" ] || { printf 'No completed app-data backup is available.\n' >&2; exit 1; }
printf 'Verifying app-data/%s...\n' "${app_set##*/}"
verify_app_data "$app_set"
app_completed_at="$(jq -er '.completedAt' "$app_set/manifest.json")"

selection="$(mktemp)"
stage=""
previous_app=""
previous_websites=""
swapped=0
database_started=0
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  [ "$database_started" -eq 0 ] || compose stop hosting-db >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ] && [ "$swapped" -eq 1 ]; then
    rm -rf "$root/app-data" "$root/websites"
    [ -z "$previous_app" ] || mv "$previous_app" "$root/app-data"
    [ -z "$previous_websites" ] || mv "$previous_websites" "$root/websites"
    start_control_services >/dev/null 2>&1 || true
  fi
  [ -z "$stage" ] || rm -rf "$stage"
  rm -f "$selection"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

for group_dir in "$backups"/*; do
  [ -d "$group_dir" ] || continue
  group="${group_dir##*/}"
  [ "$group" != app-data ] || continue
  set_dir="$(latest_site_set_at_or_before "$group" "$app_completed_at")"
  [ -n "$set_dir" ] || continue
  [ "$(jq -r '.type // empty' "$set_dir/manifest.json" 2>/dev/null)" = site ] || continue
  printf 'Verifying %s/%s...\n' "$group" "${set_dir##*/}"
  verify_site "$set_dir"
  printf '%s\n' "$set_dir" >> "$selection"
done

site_count="$(wc -l < "$selection" | tr -d ' ')"
app_id="${app_set##*/}"
printf 'Recovery point: app-data %s, %s website sets.\n' "$app_id" "$site_count"

if [ "$mode" = dry-run ]; then
  printf 'Standby preparation dry run passed.\n'
  exit 0
fi

mkdir -p /run/hosting-backup-receiver
exec 9>"/run/hosting-backup-receiver/lock"
flock -n 9 || { printf 'Backup reception is active; preparation refused.\n' >&2; exit 1; }
[ ! -d "$backups/.incoming" ] || [ -z "$(find "$backups/.incoming" -mindepth 1 -maxdepth 1 -print -quit)" ] \
  || { printf 'Interrupted backup staging exists; preparation refused.\n' >&2; exit 1; }

receiver_receipt="$backups/receiver-state.json"
deep_receipt="$backups/deep-verify-state.json"
[ -f "$receiver_receipt" ] && [ -f "$deep_receipt" ] \
  || { printf 'Current receiver and deep-verification receipts are required before apply.\n' >&2; exit 1; }
receiver_sha="$(sha256sum "$receiver_receipt" | awk '{print $1}')"
jq -e --arg receiver_sha "$receiver_sha" '
  .version == 1 and .result == "success" and
  .receiverReceiptSha256 == $receiver_sha and
  (.verifiedCount | type == "number") and .verifiedCount > 0 and .verifiedCount <= 5000 and
  (.verifiedSets | type == "array") and (.verifiedSets | length) == .verifiedCount
' "$deep_receipt" >/dev/null \
  || { printf 'Deep verification is missing, invalid, or stale for the current receiver receipt.\n' >&2; exit 1; }
deep_sha="$(sha256sum "$deep_receipt" | awk '{print $1}')"

unexpected="$(docker ps --format '{{.Names}}' | awk '/^hosting-/ && $0 !~ /^(hosting-agent|hosting-ui|hosting-cloudflared)$/ { print }')"
[ -z "$unexpected" ] || { printf 'Writable hosting containers are running: %s\n' "$unexpected" >&2; exit 1; }

available_kb="$(df -Pk "$root" | awk 'NR == 2 { print $4 }')"
[ "$available_kb" -ge 20971520 ] || { printf 'At least 20 GiB free space is required for staging.\n' >&2; exit 1; }

stage="$root/.standby-prepare.$$"
mkdir -p "$stage/app-data" "$stage/websites"
tar -xzf "$app_set/app-data.tar.gz" -C "$stage/app-data" --no-same-owner
while IFS= read -r set_dir; do
  [ -n "$set_dir" ] || continue
  tar -xzf "$set_dir/website.tar.gz" -C "$stage/websites" --no-same-owner
done < "$selection"
mkdir -p "$stage/app-data/mysql" "$stage/app-data/nginx-cache" "$stage/app-data/redis"
chown -R 33:33 "$stage/app-data" "$stage/websites"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
previous_app="$root/.standby-previous-app-data-$stamp"
previous_websites="$root/.standby-previous-websites-$stamp"
compose stop hosting-ui >/dev/null 2>&1 || true
[ ! -e "$root/app-data" ] || mv "$root/app-data" "$previous_app"
[ ! -e "$root/websites" ] || mv "$root/websites" "$previous_websites"
mv "$stage/app-data" "$root/app-data"
mv "$stage/websites" "$root/websites"
swapped=1

compose up -d hosting-db
database_started=1
ready=0
for _ in $(seq 1 60); do
  if docker exec hosting-db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot -Nse "SELECT 1"' 2>/dev/null \
    | grep -qx 1; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" -eq 1 ] || { printf 'Replica database did not become ready.\n' >&2; exit 1; }
gzip -dc "$app_set/databases.sql.gz" \
  | docker exec -i hosting-db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot'
restored_tables="$(docker exec hosting-db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot -Nse "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN (0x696e666f726d6174696f6e5f736368656d61,0x706572666f726d616e63655f736368656d61,0x737973)"')"
case "$restored_tables" in ''|*[!0-9]*) printf 'Restored database inventory is invalid.\n' >&2; exit 1 ;; esac
[ "$restored_tables" -gt 0 ] || { printf 'Restored database inventory is empty.\n' >&2; exit 1; }
compose stop hosting-db
database_started=0

# Materialize the promotion runtime without starting writable or public services.
# Preflight can then verify the exact images and container definitions that a
# controlled promotion would start.
compose create hosting-db hosting-redis hosting-php-fpm hosting-nginx >/dev/null

rm -rf "$previous_app" "$previous_websites"
previous_app=""
previous_websites=""
swapped=0
stage=""

source_release="$(cat "$project_dir/.source-release" 2>/dev/null || printf unknown)"
temporary="$machine_state/standby-recovery.json.tmp.$$"
jq -n --arg prepared_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg app_data_id "$app_id" \
  --arg source_release "$source_release" --arg receiver_receipt_sha256 "$receiver_sha" \
  --arg deep_verification_sha256 "$deep_sha" --argjson site_count "$site_count" \
  '{version:1, prepared_at:$prepared_at, app_data_id:$app_data_id, site_count:$site_count,
    source_release:$source_release, receiver_receipt_sha256:$receiver_receipt_sha256,
    deep_verification_sha256:$deep_verification_sha256}' > "$temporary"
chmod 644 "$temporary"
mv "$temporary" "$machine_state/standby-recovery.json"

start_control_services
printf 'Standby prepared at app-data recovery point %s. Role and public traffic were not changed.\n' "$app_id"
