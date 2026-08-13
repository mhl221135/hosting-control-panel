#!/bin/bash

set -euo pipefail

usage() {
  printf 'Usage: restore-replication-dump.sh --verify|--apply [--root PATH]\n' >&2
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
mode=""
root=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify|--apply) mode="$1" ;;
    --root) shift; root="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done
[ -n "$mode" ] || { usage; exit 2; }
[ -f "$env_file" ] || { printf 'Missing .env file.\n' >&2; exit 1; }

env_value() {
  awk -v key="$1" 'index($0,key "=")==1 {
    value=substr($0,length(key)+2)
    if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) value=substr(value,2,length(value)-2)
    print value; exit
  }' "$env_file"
}
root="${root:-$(env_value HOSTING_ROOT)}"
root="${root:-/media/ssdmount/websites-v2}"
database_root="$root/replication/database"
latest="$(find "$database_root" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??-??-??Z' -print 2>/dev/null \
  | sed 's#^.*/##' | sort -r | sed -n '1p')"
[ -n "$latest" ] || { printf 'No synchronized database recovery point exists.\n' >&2; exit 1; }
set_dir="$database_root/$latest"
manifest="$set_dir/manifest.json"
artifact="$set_dir/all-databases.sql.gz"
[ -f "$manifest" ] && [ ! -L "$manifest" ] && [ -f "$artifact" ] && [ ! -L "$artifact" ] \
  || { printf 'Latest database recovery point is incomplete.\n' >&2; exit 1; }
jq -e --arg id "$latest" '.version == 1 and .id == $id and
  .artifact == "all-databases.sql.gz" and (.size | type == "number") and
  (.sha256 | type == "string") and (.sha256 | test("^[a-f0-9]{64}$")) and
  (.createdAt | type == "string") and ((now - (.createdAt | fromdateiso8601)) >= 0) and
  ((now - (.createdAt | fromdateiso8601)) <= 10800)' "$manifest" >/dev/null \
  || { printf 'Database recovery manifest is invalid.\n' >&2; exit 1; }
[ "$(wc -c < "$artifact" | tr -d ' ')" = "$(jq -r .size "$manifest")" ] \
  || { printf 'Database recovery size does not match its manifest.\n' >&2; exit 1; }
[ "$(sha256sum "$artifact" | awk '{print $1}')" = "$(jq -r .sha256 "$manifest")" ] \
  || { printf 'Database recovery checksum does not match its manifest.\n' >&2; exit 1; }
gzip -t "$artifact"

if [ "$mode" = --apply ]; then
  docker inspect hosting-db >/dev/null 2>&1 || { printf 'hosting-db is unavailable.\n' >&2; exit 1; }
  gzip -dc "$artifact" | docker exec -i hosting-db sh -c \
    'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot --binary-mode=1'
  docker exec hosting-db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot -e "FLUSH PRIVILEGES"'
  printf 'Restored synchronized database recovery point %s.\n' "$latest" >&2
fi
printf '%s\n' "$latest"
