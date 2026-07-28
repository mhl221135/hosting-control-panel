#!/bin/sh

set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
continuing=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --continue-after-pull)
      continuing=true
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

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

set_agent_token() {
  token="$1"
  temporary="$project_dir/.env.agent.$$"
  awk -v token="$token" '
    BEGIN { written = 0 }
    /^HOSTING_AGENT_TOKEN=/ {
      if (!written) print "HOSTING_AGENT_TOKEN=" token
      written = 1
      next
    }
    { print }
    END {
      if (!written) print "HOSTING_AGENT_TOKEN=" token
    }
  ' "$project_dir/.env" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$project_dir/.env"
}

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

if [ "$continuing" = false ]; then
  previous_commit="$(git -C "$project_dir" rev-parse HEAD)"
  git -C "$project_dir" pull --ff-only origin main
  current_commit="$(git -C "$project_dir" rev-parse HEAD)"
  if [ "$previous_commit" != "$current_commit" ]; then
    echo "Source updated; restarting with the new upgrade script."
    exec "$project_dir/scripts/upgrade.sh" --continue-after-pull
  fi
fi

hosting_agent_token="$(env_value HOSTING_AGENT_TOKEN)"
case "$hosting_agent_token" in
  ""|replace-with-*)
    umask 077
    set_agent_token "$(generate_secret)"
    echo "Generated the private hosting-agent authentication token."
    ;;
esac

cd "$project_dir"
compose config --quiet
compose pull hosting-nginx hosting-redis hosting-db hosting-phpmyadmin || true
compose build --pull hosting-agent hosting-files hosting-ui hosting-php-fpm hosting-npm
compose up -d hosting-agent
compose run --rm --no-deps hosting-ui node /app/cli/migrate-static-routes.js
compose run --rm --no-deps hosting-ui node /app/cli/migrate-commerce-cache.js
compose up -d
sh "$project_dir/scripts/migrate-webp-cache.sh"

echo "Upgrade complete. Persistent data, websites, backups, and active configuration were not replaced."
