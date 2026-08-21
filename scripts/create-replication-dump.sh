#!/bin/bash

set -euo pipefail

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

machine_state="$(env_value HOSTING_MACHINE_STATE_DIR)"
machine_state="${machine_state:-/etc/hosting-control}"
role="$(jq -r '.role // empty' "$machine_state/role.json" 2>/dev/null || true)"
[ "$role" = primary ] || { printf 'Database replication dumps run only on the primary.\n' >&2; exit 1; }
root="$(env_value HOSTING_ROOT)"
root="${root:-/media/ssdmount/websites-v2}"
destination="$root/replication/database"
mkdir -p "$destination"
chmod 750 "$root/replication" "$destination"

lock_dir=/run/hosting-control
install -d -m 700 "$lock_dir"
exec 9>"$lock_dir/database-replication.lock"
flock -n 9 || { printf 'A database replication dump is already running.\n' >&2; exit 0; }

id="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
partial="$destination/.partial-$id"
complete="$destination/$id"
trap 'rm -rf -- "$partial"' EXIT HUP INT TERM
mkdir "$partial"

cd "$project_dir"
docker compose ps --status running hosting-db | grep -q hosting-db \
  || { printf 'hosting-db is not running.\n' >&2; exit 1; }

docker exec hosting-db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysqldump \
  --all-databases --single-transaction --quick --routines --events --triggers \
  --hex-blob --set-gtid-purged=OFF --default-character-set=utf8mb4 -uroot' \
  | gzip -1 > "$partial/all-databases.sql.gz"
gzip -t "$partial/all-databases.sql.gz"
size="$(stat -c %s "$partial/all-databases.sql.gz")"
sha="$(sha256sum "$partial/all-databases.sql.gz" | awk '{print $1}')"
jq -n --arg id "$id" --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg sha256 "$sha" --argjson size "$size" \
  '{version:1,id:$id,createdAt:$created_at,artifact:"all-databases.sql.gz",size:$size,sha256:$sha256}' \
  > "$partial/manifest.json"
chmod 640 "$partial/all-databases.sql.gz" "$partial/manifest.json"
chown -R 33:33 "$partial"
mv "$partial" "$complete"
trap - EXIT HUP INT TERM

find "$destination" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??-??-??Z' -print \
  | sed 's#^.*/##' | sort -r | sed -n '4,$p' \
  | while IFS= read -r old; do rm -rf -- "$destination/$old"; done
printf 'Created hourly database recovery point %s (%s bytes).\n' "$id" "$size"
