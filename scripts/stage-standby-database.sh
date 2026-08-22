#!/bin/sh

set -eu

[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
[ -f "$env_file" ] || { printf 'Missing .env file.\n' >&2; exit 1; }

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
role="$(jq -r '.role // empty' "$machine_state/role.json" 2>/dev/null || true)"
[ "$role" = standby ] || { printf 'Database staging is skipped because this machine is not standby.\n'; exit 0; }

mkdir -p /run/hosting-backup-receiver "$machine_state"
exec 9>/run/hosting-backup-receiver/lock
flock -n 9 || { printf 'Another standby operation is active; database staging skipped.\n'; exit 0; }

recovery_id="$("$project_dir/scripts/restore-replication-dump.sh" --verify --root "$root")"
manifest="$root/replication/database/$recovery_id/manifest.json"
artifact_sha="$(jq -r .sha256 "$manifest")"
marker="$machine_state/standby-database-prepared.json"
if [ -f "$marker" ] && jq -e --arg id "$recovery_id" --arg sha "$artifact_sha" '
  .version == 1 and .recovery_id == $id and .artifact_sha256 == $sha
' "$marker" >/dev/null 2>&1; then
  printf 'Standby database recovery point %s is already staged.\n' "$recovery_id"
  exit 0
fi

unexpected="$(docker ps --format '{{.Names}}' | awk '
  /^hosting-/ && $0 !~ /^(hosting-agent|hosting-ui|hosting-cloudflared|hosting-sync)$/ { print }
')"
[ -z "$unexpected" ] \
  || { printf 'Writable hosting containers are running; database staging refused: %s\n' "$unexpected" >&2; exit 1; }

cd "$project_dir"
docker compose up -d hosting-db
cleanup() { docker compose stop hosting-db >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
ready=0
for _ in $(seq 1 60); do
  if docker exec hosting-db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot -Nse "SELECT 1"' 2>/dev/null \
    | grep -qx 1; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" -eq 1 ] || { printf 'Standby database did not become ready for staging.\n' >&2; exit 1; }
restored_id="$("$project_dir/scripts/restore-replication-dump.sh" --apply --root "$root")"
[ "$restored_id" = "$recovery_id" ] || { printf 'Database recovery point changed during staging.\n' >&2; exit 1; }
docker exec hosting-db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot -Nse "SELECT 1"' | grep -qx 1
docker compose stop hosting-db >/dev/null
trap - EXIT HUP INT TERM

temporary="$marker.tmp.$$"
jq -n --arg recovery_id "$recovery_id" --arg artifact_sha256 "$artifact_sha" \
  --arg prepared_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{version:1,recovery_id:$recovery_id,artifact_sha256:$artifact_sha256,prepared_at:$prepared_at}' \
  > "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$marker"
printf 'Standby database recovery point %s was staged and stopped.\n' "$recovery_id"
