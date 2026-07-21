#!/bin/sh

set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if [ "$#" -gt 0 ]; then
  echo "Unknown upgrade option: $1" >&2
  exit 1
fi

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

cd "$project_dir"
compose config --quiet
compose pull hosting-nginx hosting-redis hosting-db hosting-phpmyadmin || true
compose build --pull hosting-files hosting-ui hosting-php-fpm hosting-npm
compose up -d
sh "$project_dir/scripts/migrate-webp-cache.sh"

echo "Upgrade complete. Persistent data, websites, backups, and active configuration were not replaced."
