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

machine_state="$(env_value HOSTING_MACHINE_STATE_DIR)"
machine_state="${machine_state:-/etc/hosting-control}"
role="$(jq -r '.role // empty' "$machine_state/role.json" 2>/dev/null || true)"
[ "$role" = standby ] || { printf 'Warm runtime is restricted to the standby role.\n' >&2; exit 1; }

cd "$project_dir"
docker compose stop hosting-phpmyadmin hosting-files hosting-billing >/dev/null
docker compose up -d hosting-db hosting-npm >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec hosting-db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot -Nse "SELECT 1"' 2>/dev/null \
    | grep -qx 1; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" -eq 1 ] || { printf 'Standby database did not become ready.\n' >&2; exit 1; }

docker exec hosting-db sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot -Nse \
  "SET PERSIST read_only=ON; SET PERSIST super_read_only=ON; SELECT @@GLOBAL.read_only,@@GLOBAL.super_read_only"' \
  | awk '$1 == 1 && $2 == 1 { ok=1 } END { exit !ok }'
docker compose up -d hosting-redis hosting-php-fpm hosting-nginx >/dev/null
docker exec hosting-php-fpm php-fpm -t >/dev/null
docker exec hosting-nginx nginx -t >/dev/null

unexpected="$(docker ps --format '{{.Names}}' | awk '
  /^hosting-/ && $0 !~ /^(hosting-agent|hosting-ui|hosting-cloudflared|hosting-sync|hosting-db|hosting-redis|hosting-php-fpm|hosting-nginx|hosting-npm)$/ { print }
')"
[ -z "$unexpected" ] \
  || { printf 'Unexpected writable hosting containers remain on standby: %s\n' "$unexpected" >&2; exit 1; }
printf 'Warm standby runtime is ready; MySQL is persistent read-only and public mutators are stopped.\n'
