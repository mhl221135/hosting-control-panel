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
[ "$role" = standby ] || { printf 'Machine is not standby; boot fence did not change services.\n'; exit 0; }

cd "$project_dir"
docker compose stop \
  hosting-npm hosting-phpmyadmin hosting-files hosting-billing hosting-nginx \
  hosting-php-fpm hosting-redis hosting-db >/dev/null

unexpected="$(docker ps --format '{{.Names}}' | awk '
  /^hosting-/ && $0 !~ /^(hosting-agent|hosting-ui|hosting-cloudflared|hosting-sync)$/ { print }
')"
[ -z "$unexpected" ] \
  || { printf 'Writable hosting containers remain on standby: %s\n' "$unexpected" >&2; exit 1; }
printf 'Standby boot fence verified; writable hosting services are stopped.\n'
