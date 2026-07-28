#!/usr/bin/env bash

set -Eeuo pipefail

backups_root=""
work_root="${TMPDIR:-/tmp}"
max_database_mib=512
mysql_image="mysql:8.4"
temporary=""
mysql_container=""

usage() {
  cat <<'EOF'
Usage: qualify-local-recovery.sh --backups-root PATH [options]

Non-destructive local recovery qualification. It validates and extracts the
latest app-data set, then restores one bounded representative site database
into an isolated temporary MySQL container.

Options:
  --backups-root PATH       Backup root containing app-data and website sets
  --work-root PATH          Temporary extraction filesystem (default: TMPDIR)
  --max-database-mib N      Maximum compressed representative dump (default: 512)
  --mysql-image IMAGE       Pinned test image (default: mysql:8.4)
  --help                    Show this help

The script never writes to backup artifacts, production websites, production
MySQL, Compose services, DNS, or proxy configuration.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --backups-root) backups_root="${2:-}"; shift 2 ;;
    --work-root) work_root="${2:-}"; shift 2 ;;
    --max-database-mib) max_database_mib="${2:-}"; shift 2 ;;
    --mysql-image) mysql_image="${2:-}"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 64 ;;
  esac
done

case "$backups_root" in /*) ;; *) printf '%s\n' '--backups-root must be absolute.' >&2; exit 64 ;; esac
case "$work_root" in /*) ;; *) printf '%s\n' '--work-root must be absolute.' >&2; exit 64 ;; esac
[[ "$max_database_mib" =~ ^[0-9]+$ ]] && [ "$max_database_mib" -ge 1 ] || {
  printf '%s\n' '--max-database-mib must be a positive integer.' >&2
  exit 64
}
[[ "$mysql_image" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  printf '%s\n' '--mysql-image must be an explicitly tagged image reference.' >&2
  exit 64
}
[ -d "$backups_root/app-data" ] || { printf 'App-data backup directory is missing.\n' >&2; exit 1; }
mkdir -p "$work_root"

cleanup() {
  if [ -n "$mysql_container" ]; then
    docker rm -f "$mysql_container" >/dev/null 2>&1 || true
  fi
  if [ -n "$temporary" ] && [ -d "$temporary" ]; then
    rm -rf -- "$temporary"
  fi
}
trap cleanup EXIT HUP INT TERM

for command in docker jq python3 gzip tar sha256sum find sort awk; do
  command -v "$command" >/dev/null 2>&1 || { printf 'Required command is missing: %s\n' "$command" >&2; exit 1; }
done

safe_archive() {
  local archive="$1" required_prefix="${2:-}"
  python3 - "$archive" "$required_prefix" <<'PY'
import pathlib
import posixpath
import sys
import tarfile

archive, required_prefix = sys.argv[1:]
members = 0
with tarfile.open(archive, "r:gz") as source:
    for member in source:
        members += 1
        name = member.name.removeprefix("./")
        item = pathlib.PurePosixPath(name)
        normalized = posixpath.normpath(name)
        if item.is_absolute() or normalized == ".." or normalized.startswith("../"):
            raise SystemExit("archive contains an unsafe path")
        if required_prefix and name != required_prefix and not name.startswith(required_prefix + "/"):
            raise SystemExit("archive contains a path outside the manifest website root")
        if member.issym() or member.islnk():
            target = member.linkname
            if posixpath.isabs(target):
                raise SystemExit("archive contains an absolute link")
            resolved = posixpath.normpath(
                posixpath.join(posixpath.dirname(normalized), target) if member.issym() else target
            )
            if resolved == ".." or resolved.startswith("../"):
                raise SystemExit("archive contains a link outside the restore root")
            if required_prefix and resolved != required_prefix and not resolved.startswith(required_prefix + "/"):
                raise SystemExit("archive contains a link outside the manifest website root")
if members == 0:
    raise SystemExit("archive is empty")
print(members)
PY
}

latest_set() {
  find "$1" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??T??-??-??Z' -print | sort | tail -n 1
}

printf 'Local disaster-recovery qualification\n'
printf '%s\n' '====================================='

app_set="$(latest_set "$backups_root/app-data")"
[ -n "$app_set" ] || { printf 'No complete app-data backup set found.\n' >&2; exit 1; }
app_manifest="$app_set/manifest.json"
jq -e '
  .version == 1 and .type == "app-data"
  and (.id | test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$"))
  and (.excluded == ["mysql", "nginx-cache"])
' "$app_manifest" >/dev/null || { printf 'App-data manifest contract failed.\n' >&2; exit 1; }
[ "$(basename "$app_set")" = "$(jq -r .id "$app_manifest")" ] || {
  printf 'App-data directory and manifest identifiers differ.\n' >&2
  exit 1
}
for artifact in app-data.tar.gz databases.sql.gz; do
  [ -f "$app_set/$artifact" ] || { printf 'App-data set is missing %s.\n' "$artifact" >&2; exit 1; }
  gzip -t "$app_set/$artifact"
  sha256sum "$app_set/$artifact" >/dev/null
done
app_entries="$(safe_archive "$app_set/app-data.tar.gz")"

temporary="$(mktemp -d "$work_root/hosting-drill.XXXXXX")"
mkdir -p "$temporary/app-data" "$temporary/site"
tar --no-same-owner --no-same-permissions -xzf "$app_set/app-data.tar.gz" -C "$temporary/app-data"
[ -d "$temporary/app-data/configs" ] || { printf 'Restored app-data is missing configs.\n' >&2; exit 1; }
[ -d "$temporary/app-data/ui-manager" ] || { printf 'Restored app-data is missing panel state.\n' >&2; exit 1; }
printf 'PASS app-data manifest, gzip, safe archive, and isolated extraction (%s entries)\n' "$app_entries"

max_database_bytes=$((max_database_mib * 1024 * 1024))
site_set=""
while IFS= read -r candidate; do
  [ -f "$candidate/manifest.json" ] && [ -f "$candidate/website.tar.gz" ] && [ -f "$candidate/database.sql.gz" ] || continue
  [ "$(stat -c %s "$candidate/database.sql.gz")" -le "$max_database_bytes" ] || continue
  if jq -e '
    .version == 1 and .type == "site"
    and (.id | test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$"))
    and (.domain | type == "string" and length > 3)
    and (.websitePath | type == "string" and length > 0)
    and (.database | type == "string" and length > 0)
  ' "$candidate/manifest.json" >/dev/null 2>&1; then
    site_set="$candidate"
    break
  fi
done < <(
  find "$backups_root" -mindepth 2 -maxdepth 2 -type d -name '20??-??-??T??-??-??Z' \
    ! -path "$backups_root/app-data/*" -printf '%f\t%p\n' | sort -r | cut -f2-
)
[ -n "$site_set" ] || { printf 'No bounded database-bearing website backup set found.\n' >&2; exit 1; }

site_manifest="$site_set/manifest.json"
[ "$(basename "$site_set")" = "$(jq -r .id "$site_manifest")" ] || {
  printf 'Website directory and manifest identifiers differ.\n' >&2
  exit 1
}
[ "$(basename "$(dirname "$site_set")")" = "$(jq -r .domain "$site_manifest")" ] || {
  printf 'Website backup ownership check failed.\n' >&2
  exit 1
}
website_path="$(jq -r .websitePath "$site_manifest")"
case "$website_path" in
  ""|/*|*".."*) printf 'Website path in manifest is unsafe.\n' >&2; exit 1 ;;
esac
database_name="$(jq -r .database "$site_manifest")"
[[ "$database_name" =~ ^[A-Za-z0-9_$-]{1,64}$ ]] || { printf 'Database name in manifest is unsafe.\n' >&2; exit 1; }

gzip -t "$site_set/website.tar.gz"
gzip -t "$site_set/database.sql.gz"
sha256sum "$site_set/website.tar.gz" "$site_set/database.sql.gz" >/dev/null
site_entries="$(safe_archive "$site_set/website.tar.gz" "$website_path")"
tar --no-same-owner --no-same-permissions -xzf "$site_set/website.tar.gz" -C "$temporary/site"
[ -d "$temporary/site/$website_path" ] || { printf 'Website root was not restored.\n' >&2; exit 1; }
printf 'PASS representative website manifest, ownership, safe archive, and isolated extraction (%s entries)\n' "$site_entries"

mysql_container="hosting-drill-$RANDOM-$$"
docker run -d --rm \
  --name "$mysql_container" \
  --network none \
  --memory 1g \
  --cpus 1 \
  --pids-limit 256 \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes \
  "$mysql_image" \
  --skip-log-bin \
  --innodb-buffer-pool-size=256M >/dev/null

ready=false
for _ in $(seq 1 90); do
  mysql_logs="$(docker logs "$mysql_container" 2>&1 || true)"
  if [[ "$mysql_logs" == *"MySQL init process done. Ready for start up."* ]] \
    && docker exec "$mysql_container" mysqladmin ping -uroot --silent >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || { printf 'Isolated MySQL did not become ready.\n' >&2; exit 1; }

docker exec "$mysql_container" mysql -uroot -e "CREATE DATABASE \`${database_name}\`;" >/dev/null
if ! gzip -dc "$site_set/database.sql.gz" \
  | docker exec -i "$mysql_container" mysql -uroot \
    --init-command="SET SESSION sql_mode='ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'" \
    "$database_name" >/dev/null 2>"$temporary/mysql-import.log"; then
  printf 'Representative database import failed; temporary error output will be removed.\n' >&2
  exit 1
fi
table_count="$(docker exec "$mysql_container" mysql -uroot -N -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${database_name//\'/\'\'}';")"
[[ "$table_count" =~ ^[0-9]+$ ]] && [ "$table_count" -gt 0 ] || {
  printf 'Representative database restored without application tables.\n' >&2
  exit 1
}
printf 'PASS representative database imported into isolated no-network MySQL (%s tables)\n' "$table_count"

printf '\nQualification passed.\n'
printf 'Production data was not modified. Temporary extraction and MySQL were removed.\n'
