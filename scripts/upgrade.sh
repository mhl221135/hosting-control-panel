#!/bin/sh

set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
include_production=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --production)
      include_production=true
      ;;
    *)
      echo "Unknown upgrade option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this upgrade as root." >&2
  exit 1
fi
if [ ! -f "$project_dir/.env" ]; then
  echo "$project_dir/.env is missing. This does not look like an installed stack." >&2
  exit 1
fi
if [ -n "$(git -C "$project_dir" status --porcelain --untracked-files=no)" ]; then
  echo "Tracked source files have local changes. Commit or discard them before upgrading." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  compose() {
    docker compose "$@"
  }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() {
    docker-compose "$@"
  }
else
  echo "Docker Compose is required." >&2
  exit 1
fi

git -C "$project_dir" pull --ff-only origin main

env_value() {
  awk -v key="$1" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
      if (value ~ /^".*"$/ || value ~ /^'\''.*'\''$/) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "$project_dir/.env"
}

hosting_root="$(env_value HOSTING_ROOT)"
hosting_root="${hosting_root:-/media/ssdmount/websites-v2}"
mkdir -p "$hosting_root/app-data/npm/data/nginx/custom"
install -m 0644 \
  "$project_dir/global-configs-new-upd/npm/http_top.conf" \
  "$hosting_root/app-data/npm/data/nginx/custom/http_top.conf"

cd "$project_dir"
compose config --quiet
compose pull hosting-npm
compose pull hosting-nginx hosting-redis hosting-db hosting-phpmyadmin || true
compose build --pull hosting-files hosting-ui hosting-php-fpm
compose up -d

if [ "$include_production" = true ]; then
  compose --profile production pull hosting-goaccess || true
  compose --profile production up -d hosting-goaccess
fi

echo "Upgrade complete. Persistent data, websites, backups, and active configuration were not replaced."
