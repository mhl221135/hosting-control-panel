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

set_generated_value() {
  key="$1"
  value="$2"
  temporary="$project_dir/.env.generated.$$"
  awk -v key="$key" -v value="$value" '
    BEGIN { written = 0 }
    index($0, key "=") == 1 {
      if (!written) print key "=" value
      written = 1
      next
    }
    { print }
    END {
      if (!written) print key "=" value
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
    set_generated_value HOSTING_AGENT_TOKEN "$(generate_secret)"
    echo "Generated the private hosting-agent authentication token."
    ;;
esac
billing_api_token="$(env_value BILLING_API_TOKEN)"
case "$billing_api_token" in
  ""|replace-with-*)
    umask 077
    set_generated_value BILLING_API_TOKEN "$(generate_secret)"
    echo "Generated the private billing API authentication token."
    ;;
esac

hosting_root="$(env_value HOSTING_ROOT)"
hosting_root="${hosting_root:-/media/ssdmount/websites-v2}"
backups_dir="$(env_value BACKUPS_DIR)"
backups_dir="${backups_dir:-$hosting_root/backups}"
exports_dir="$(env_value EXPORTS_DIR)"
exports_dir="${exports_dir:-$hosting_root/exports}"
installation_role="$(env_value INSTALLATION_ROLE)"
installation_role="${installation_role:-standalone}"
server_id="$(env_value SERVER_ID)"
server_id="${server_id:-$(hostname -s 2>/dev/null || printf 'hosting-server')}"
machine_state_dir="$(env_value HOSTING_MACHINE_STATE_DIR)"
machine_state_dir="${machine_state_dir:-/etc/hosting-control}"
ui_data_dir="$(env_value UI_DATA_DIR)"
if [ -z "$ui_data_dir" ]; then
  if [ "$installation_role" = "standby" ]; then ui_data_dir="$machine_state_dir/ui-data"; else ui_data_dir="$hosting_root/app-data/ui-manager"; fi
fi
tunnel_enabled="$(env_value HOSTING_TUNNEL_ENABLED)"
tunnel_enabled="${tunnel_enabled:-false}"
tunnel_token_file="$(env_value HOSTING_TUNNEL_TOKEN_FILE)"
tunnel_token_file="${tunnel_token_file:-/etc/hosting-control/cloudflared-hosting.token}"

case "$installation_role" in standalone|primary|standby) ;; *) echo "INSTALLATION_ROLE is invalid." >&2; exit 1 ;; esac
case "$tunnel_enabled" in true|false) ;; *) echo "HOSTING_TUNNEL_ENABLED must be true or false." >&2; exit 1 ;; esac
if [ "$tunnel_enabled" = true ]; then
  [ -f "$tunnel_token_file" ] || { echo "Hosting tunnel token file does not exist: $tunnel_token_file" >&2; exit 1; }
fi
case "$server_id" in ''|*[!A-Za-z0-9._-]*|-*|.*|_*) echo "SERVER_ID is invalid." >&2; exit 1 ;; esac
mkdir -p "$machine_state_dir"
mkdir -p "$ui_data_dir"
chown -R 33:33 "$ui_data_dir"
role_marker="$machine_state_dir/role.json"
if [ ! -e "$role_marker" ]; then
  umask 022
  marker_tmp="$role_marker.tmp.$$"
  printf '{\n  "version": 1,\n  "role": "%s",\n  "server_id": "%s"\n}\n' "$installation_role" "$server_id" > "$marker_tmp"
  chmod 644 "$marker_tmp"
  mv "$marker_tmp" "$role_marker"
fi
chmod 644 "$role_marker"

mkdir -p "$hosting_root/app-data/billing" "$backups_dir/billing"
chown -R 33:33 "$hosting_root/app-data/billing" "$backups_dir/billing"

php_fpm_config="$hosting_root/app-data/configs/php-fpm/php-fpm.conf"
if ! grep -qxF 'include=/runtime-php-fpm/pools.conf' "$php_fpm_config"; then
  printf '\ninclude=/runtime-php-fpm/pools.conf\n' >> "$php_fpm_config"
fi

HOSTING_ROOT="$hosting_root" BACKUPS_DIR="$backups_dir" EXPORTS_DIR="$exports_dir" \
  sh "$project_dir/scripts/migrate-ui-permissions.sh"

cd "$project_dir"
compose config --quiet
compose pull hosting-nginx hosting-redis hosting-db hosting-phpmyadmin || true
[ "$tunnel_enabled" = false ] || compose pull hosting-cloudflared
compose build --pull hosting-agent hosting-files hosting-ui hosting-billing hosting-php-fpm hosting-npm
compose up -d hosting-agent
if [ "$installation_role" = "standby" ]; then
  compose stop hosting-files hosting-billing hosting-php-fpm hosting-nginx hosting-npm hosting-redis hosting-db hosting-phpmyadmin || true
  if [ "$tunnel_enabled" = true ]; then
    compose up -d hosting-agent hosting-ui hosting-cloudflared
  else
    compose up -d hosting-agent hosting-ui
  fi
  echo "Standby upgraded. Writable and public services remain stopped."
else
  compose run --rm --no-deps hosting-ui node /app/cli/migrate-static-routes.js --apply
  compose run --rm --no-deps hosting-ui node /app/cli/migrate-commerce-cache.js
  compose up -d
  [ "$tunnel_enabled" = false ] || compose up -d hosting-cloudflared
  sh "$project_dir/scripts/migrate-webp-cache.sh"
fi

echo "Upgrade complete. Persistent data, websites, backups, and active configuration were not replaced."
