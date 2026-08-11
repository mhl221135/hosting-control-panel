#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: promote-standby.sh [options]

Options:
  --root PATH          Standby installation root (default: HOSTING_ROOT from .env)
  --dry-run            Validate the prepared recovery point without changing services
  --apply              Activate the prepared local stack and change the role to primary
  --recovery-id ID     Exact prepared app-data recovery identifier
  --confirm TEXT       Required with --apply; must be PROMOTE-STANDBY
  --fence-confirm TEXT Required with --apply; must be OLD-PRIMARY-FENCED

This command never changes DNS, Cloudflare routes, NPM hosts, router settings,
or public tunnel hostname routes.
EOF
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
root=""
mode=""
recovery_id=""
confirmation=""
fence_confirmation=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; root="$1" ;;
    --dry-run) mode=dry-run ;;
    --apply) mode=apply ;;
    --recovery-id) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; recovery_id="$1" ;;
    --confirm) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; confirmation="$1" ;;
    --fence-confirm) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; fence_confirmation="$1" ;;
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

root="${root:-$(env_value HOSTING_ROOT)}"
root="${root:-/media/ssdmount/websites-v2}"
backups="$(env_value BACKUPS_DIR)"
backups="${backups:-$root/backups}"
machine_state="$(env_value HOSTING_MACHINE_STATE_DIR)"
machine_state="${machine_state:-/etc/hosting-control}"
role_marker="$machine_state/role.json"
recovery_marker="$machine_state/standby-recovery.json"
promotion_marker="$machine_state/promotion-state.json"

case "$root" in /*) ;; *) printf 'Root must be an absolute path.\n' >&2; exit 2 ;; esac
case "$backups" in /*) ;; *) printf 'Backups must be an absolute path.\n' >&2; exit 2 ;; esac
for command in jq sha256sum flock docker awk grep find seq; do
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

[ -f "$role_marker" ] && [ -f "$recovery_marker" ] \
  || { printf 'Standby role or prepared recovery marker is missing.\n' >&2; exit 1; }
jq -e '.version == 1 and .role == "standby" and (.server_id | type == "string") and (.server_id | length > 0)' \
  "$role_marker" >/dev/null || { printf 'This machine is not an authoritative standby.\n' >&2; exit 1; }
jq -e '.version == 1 and (.app_data_id | type == "string") and (.site_count | type == "number") and
  (.source_release | type == "string") and (.receiver_receipt_sha256 | type == "string") and
  (.deep_verification_sha256 | type == "string")' "$recovery_marker" >/dev/null \
  || { printf 'Prepared recovery marker is invalid.\n' >&2; exit 1; }

prepared_id="$(jq -r .app_data_id "$recovery_marker")"
case "$prepared_id" in ????-??-??T??-??-??Z) ;; *) printf 'Prepared recovery identifier is invalid.\n' >&2; exit 1 ;; esac
[ -z "$recovery_id" ] || [ "$recovery_id" = "$prepared_id" ] \
  || { printf 'Requested recovery identifier does not match prepared recovery %s.\n' "$prepared_id" >&2; exit 1; }

receiver_receipt="$backups/receiver-state.json"
deep_receipt="$backups/deep-verify-state.json"
[ -f "$receiver_receipt" ] && [ -f "$deep_receipt" ] \
  || { printf 'Receiver and deep-verification receipts are required.\n' >&2; exit 1; }
receiver_sha="$(sha256sum "$receiver_receipt" | awk '{print $1}')"
deep_sha="$(sha256sum "$deep_receipt" | awk '{print $1}')"
[ "$receiver_sha" = "$(jq -r .receiver_receipt_sha256 "$recovery_marker")" ] \
  || { printf 'Receiver receipt changed after standby preparation. Prepare again.\n' >&2; exit 1; }
[ "$deep_sha" = "$(jq -r .deep_verification_sha256 "$recovery_marker")" ] \
  || { printf 'Deep-verification receipt changed after standby preparation. Prepare again.\n' >&2; exit 1; }
jq -e --arg receiver_sha "$receiver_sha" '.version == 1 and .result == "success" and
  .receiverReceiptSha256 == $receiver_sha and (.verifiedCount | type == "number") and .verifiedCount > 0' \
  "$deep_receipt" >/dev/null || { printf 'Deep verification is invalid or stale.\n' >&2; exit 1; }

source_release="$(cat "$project_dir/.source-release" 2>/dev/null || printf unknown)"
prepared_release="$(jq -r .source_release "$recovery_marker")"
[ "$source_release" != unknown ] && [ "$source_release" = "$prepared_release" ] \
  || { printf 'Source release does not match the prepared recovery marker.\n' >&2; exit 1; }
[ -d "$root/app-data" ] && [ -d "$root/websites" ] \
  || { printf 'Prepared app-data or websites directory is missing.\n' >&2; exit 1; }
[ -f "$root/app-data/configs/nginx/nginx.conf" ] \
  && [ -f "$root/app-data/configs/php-fpm/php-fpm.conf" ] \
  || { printf 'Prepared runtime configuration is incomplete.\n' >&2; exit 1; }

mkdir -p /run/hosting-backup-receiver
exec 9>"/run/hosting-backup-receiver/lock"
flock -n 9 || { printf 'Backup reception is active; promotion refused.\n' >&2; exit 1; }
[ ! -d "$backups/.incoming" ] || [ -z "$(find "$backups/.incoming" -mindepth 1 -maxdepth 1 -print -quit)" ] \
  || { printf 'Interrupted backup staging exists; promotion refused.\n' >&2; exit 1; }

compose config --quiet
printf 'Prepared recovery %s (%s sites) is bound to source %s.\n' \
  "$prepared_id" "$(jq -r .site_count "$recovery_marker")" "$source_release"

if [ "$mode" = dry-run ]; then
  printf 'Local promotion dry run passed. Public ingress was not inspected or changed.\n'
  exit 0
fi

[ "$confirmation" = PROMOTE-STANDBY ] \
  || { printf 'Apply requires --confirm PROMOTE-STANDBY.\n' >&2; exit 2; }
[ "$fence_confirmation" = OLD-PRIMARY-FENCED ] \
  || { printf 'Apply requires --fence-confirm OLD-PRIMARY-FENCED.\n' >&2; exit 2; }
[ "$recovery_id" = "$prepared_id" ] \
  || { printf 'Apply requires --recovery-id %s.\n' "$prepared_id" >&2; exit 2; }

receiver_timer_was_enabled=0
role_changed=0
runtime_started=0
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    if [ "$role_changed" -eq 1 ]; then
      previous="$machine_state/role.json.rollback.$$"
      jq '.role = "standby"' "$role_marker" > "$previous"
      chmod 644 "$previous"
      mv "$previous" "$role_marker"
    fi
    if [ "$runtime_started" -eq 1 ]; then
      compose stop hosting-npm hosting-phpmyadmin hosting-files hosting-billing hosting-nginx hosting-php-fpm hosting-redis hosting-db >/dev/null 2>&1 || true
    fi
    docker restart hosting-ui >/dev/null 2>&1 || true
    if [ "$receiver_timer_was_enabled" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
      systemctl enable --now hosting-backup-receiver.timer >/dev/null 2>&1 || true
    fi
    printf 'Promotion failed before public cutover; standby role and stopped runtime were restored.\n' >&2
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-enabled hosting-backup-receiver.timer >/dev/null 2>&1 && receiver_timer_was_enabled=1 || true
  systemctl stop hosting-backup-receiver.timer hosting-backup-receiver.service
fi

compose up -d hosting-db hosting-redis hosting-php-fpm hosting-nginx hosting-billing hosting-files hosting-phpmyadmin hosting-npm
runtime_started=1

db_ready=0
for _ in $(seq 1 60); do
  if docker exec hosting-db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot -Nse "SELECT 1"' 2>/dev/null \
    | grep -qx 1; then
    db_ready=1
    break
  fi
  sleep 2
done
[ "$db_ready" -eq 1 ] || { printf 'Database did not become ready.\n' >&2; exit 1; }
docker exec hosting-db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot -Nse "SELECT 1"' | grep -qx 1
docker exec hosting-php-fpm php-fpm -t >/dev/null
docker exec hosting-nginx nginx -t >/dev/null

temporary="$machine_state/role.json.promote.$$"
server_id="$(jq -r .server_id "$role_marker")"
jq -n --arg server_id "$server_id" '{version:1,role:"primary",server_id:$server_id}' > "$temporary"
chmod 644 "$temporary"
mv "$temporary" "$role_marker"
role_changed=1
docker restart hosting-ui >/dev/null

ui_ready=0
for _ in $(seq 1 30); do
  if docker exec hosting-ui wget -qO- http://127.0.0.1:8687/health >/dev/null 2>&1; then
    ui_ready=1
    break
  fi
  sleep 2
done
[ "$ui_ready" -eq 1 ] || { printf 'Panel did not become healthy after role transition.\n' >&2; exit 1; }

promotion_tmp="$promotion_marker.tmp.$$"
jq -n --arg promoted_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg recovery_id "$prepared_id" \
  --arg source_release "$source_release" --arg receiver_receipt_sha256 "$receiver_sha" \
  --arg deep_verification_sha256 "$deep_sha" --arg previous_role standby \
  '{version:1,status:"local-primary",promoted_at:$promoted_at,recovery_id:$recovery_id,
    source_release:$source_release,receiver_receipt_sha256:$receiver_receipt_sha256,
    deep_verification_sha256:$deep_verification_sha256,previous_role:$previous_role,
    public_ingress_cutover:false}' > "$promotion_tmp"
chmod 644 "$promotion_tmp"
mv "$promotion_tmp" "$promotion_marker"

role_changed=0
runtime_started=0
trap - EXIT HUP INT TERM
printf 'Local promotion completed at recovery %s. Public ingress remains unchanged and must be cut over separately.\n' "$prepared_id"
