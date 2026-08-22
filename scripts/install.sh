#!/bin/sh

set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
configure=false
requested_root=""
requested_role=""
requested_server_id=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --configure)
      configure=true
      ;;
    --root)
      shift
      [ "$#" -gt 0 ] || { echo "--root requires a directory." >&2; exit 1; }
      requested_root="$1"
      ;;
    --role)
      shift
      [ "$#" -gt 0 ] || { echo "--role requires standalone, primary, or standby." >&2; exit 1; }
      requested_role="$1"
      ;;
    --server-id)
      shift
      [ "$#" -gt 0 ] || { echo "--server-id requires a value." >&2; exit 1; }
      requested_server_id="$1"
      ;;
    *)
      echo "Unknown installer option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root." >&2
  exit 1
fi

if [ "$configure" = true ] || [ ! -f "$env_file" ]; then
  set --
  [ -z "$requested_root" ] || set -- "$@" --root "$requested_root"
  [ -z "$requested_role" ] || set -- "$@" --role "$requested_role"
  [ -z "$requested_server_id" ] || set -- "$@" --server-id "$requested_server_id"
  "$project_dir/scripts/configure.sh" "$@"
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
  ' "$env_file"
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
  temporary="$env_file.generated.$$"
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
  ' "$env_file" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$env_file"
}

hosting_agent_token="$(env_value HOSTING_AGENT_TOKEN)"
case "$hosting_agent_token" in
  ""|replace-with-*)
    umask 077
    set_generated_value HOSTING_AGENT_TOKEN "$(generate_secret)"
    ;;
esac
billing_api_token="$(env_value BILLING_API_TOKEN)"
case "$billing_api_token" in
  ""|replace-with-*)
    umask 077
    set_generated_value BILLING_API_TOKEN "$(generate_secret)"
    ;;
esac

hosting_root="${requested_root:-${HOSTING_ROOT:-$(env_value HOSTING_ROOT)}}"
hosting_root="${hosting_root:-/media/ssdmount/websites-v2}"
backups_dir="${BACKUPS_DIR:-$(env_value BACKUPS_DIR)}"
backups_dir="${backups_dir:-$hosting_root/backups}"
exports_dir="${EXPORTS_DIR:-$(env_value EXPORTS_DIR)}"
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
php_global_ini_path="$(env_value PHP_GLOBAL_INI_PATH)"

case "$installation_role" in standalone|primary|standby) ;; *) echo "INSTALLATION_ROLE is invalid." >&2; exit 1 ;; esac
if [ -n "$php_global_ini_path" ]; then
  case "$php_global_ini_path" in /*) ;; *) echo "PHP_GLOBAL_INI_PATH must be absolute." >&2; exit 1 ;; esac
fi
case "$tunnel_enabled" in true|false) ;; *) echo "HOSTING_TUNNEL_ENABLED must be true or false." >&2; exit 1 ;; esac
if [ "$tunnel_enabled" = true ]; then
  [ -f "$tunnel_token_file" ] || { echo "Hosting tunnel token file does not exist: $tunnel_token_file" >&2; exit 1; }
fi
case "$server_id" in ''|*[!A-Za-z0-9._-]*|-*|.*|_*) echo "SERVER_ID is invalid." >&2; exit 1 ;; esac
if [ "${#server_id}" -gt 64 ]; then echo "SERVER_ID is too long." >&2; exit 1; fi

mkdir -p "$machine_state_dir"
mkdir -p "$ui_data_dir"
chown -R 33:33 "$ui_data_dir"
role_marker="$machine_state_dir/role.json"
if [ -e "$role_marker" ]; then
  grep -qF "\"role\": \"$installation_role\"" "$role_marker" \
    || { echo "Existing machine role marker does not match INSTALLATION_ROLE; refusing to overwrite it." >&2; exit 1; }
  grep -qF "\"server_id\": \"$server_id\"" "$role_marker" \
    || { echo "Existing machine role marker does not match SERVER_ID; refusing to overwrite it." >&2; exit 1; }
else
  umask 022
  marker_tmp="$role_marker.tmp.$$"
  printf '{\n  "version": 1,\n  "role": "%s",\n  "server_id": "%s"\n}\n' "$installation_role" "$server_id" > "$marker_tmp"
  chmod 644 "$marker_tmp"
  mv "$marker_tmp" "$role_marker"
fi
chmod 644 "$role_marker"

case "$backups_dir" in
  /*) ;;
  *) echo "BACKUPS_DIR must be an absolute path." >&2; exit 1 ;;
esac
case "$exports_dir" in
  /*) ;;
  *) echo "EXPORTS_DIR must be an absolute path." >&2; exit 1 ;;
esac

required_variables="
UI_ADMIN_EMAIL
UI_ADMIN_PASSWORD
HOSTING_AGENT_TOKEN
BILLING_API_TOKEN
NPM_IDENTITY
NPM_SECRET
ACME_EMAIL
FILEBROWSER_ADMIN_USERNAME
FILEBROWSER_ADMIN_PASSWORD
MYSQL_ROOT_PASSWORD
NPM_DB_USER
NPM_DB_PASSWORD
NPM_DB_NAME
"

for variable in $required_variables; do
  value="$(env_value "$variable")"
  case "$value" in
    ""|replace-with-*)
      echo "$variable must be set in $env_file." >&2
      exit 1
      ;;
  esac
done

for variable in UI_ADMIN_PASSWORD HOSTING_AGENT_TOKEN BILLING_API_TOKEN NPM_SECRET FILEBROWSER_ADMIN_PASSWORD MYSQL_ROOT_PASSWORD NPM_DB_PASSWORD; do
  value="$(env_value "$variable")"
  if [ "${#value}" -lt 12 ]; then
    echo "$variable must contain at least 12 characters." >&2
    exit 1
  fi
done
billing_admin_password="$(env_value BILLING_ADMIN_PASSWORD)"
billing_admin_password="${billing_admin_password:-$(env_value UI_ADMIN_PASSWORD)}"
if [ "${#billing_admin_password}" -lt 12 ]; then
  echo "BILLING_ADMIN_PASSWORD (or its UI_ADMIN_PASSWORD fallback) must contain at least 12 characters." >&2
  exit 1
fi

chmod 600 "$env_file"

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

mkdir -p \
  "$hosting_root/app-data" \
  "$hosting_root/app-data/billing" \
  "$hosting_root/app-data/configs" \
  "$hosting_root/app-data/filebrowser/config" \
  "$hosting_root/app-data/filebrowser/database" \
  "$hosting_root/app-data/mysql" \
  "$hosting_root/app-data/nginx-cache" \
  "$hosting_root/app-data/npm/data" \
  "$hosting_root/app-data/npm/letsencrypt" \
  "$hosting_root/app-data/redis" \
  "$hosting_root/replication/database" \
  "$hosting_root/app-data/ui-manager" \
  "$backups_dir/app-data" \
  "$backups_dir/billing" \
  "$exports_dir" \
  "$hosting_root/imports" \
  "$hosting_root/websites/_default"

chown -R 33:33 "$hosting_root/app-data/billing" "$backups_dir/billing"
mkdir -p "$machine_state_dir/syncthing"
chown -R 33:33 "$machine_state_dir/syncthing" "$hosting_root/replication"
if [ ! -e "$hosting_root/replication/.stignore" ]; then
  printf '(?d) database/.partial-*\n' > "$hosting_root/replication/.stignore"
  chown 33:33 "$hosting_root/replication/.stignore"
  chmod 640 "$hosting_root/replication/.stignore"
fi

initialize_config() {
  source_path="$1"
  destination_path="$2"
  marker="$3"
  if [ ! -e "$destination_path/$marker" ]; then
    mkdir -p "$destination_path"
    cp -a "$source_path/." "$destination_path/"
  fi
}

initialize_config "$project_dir/global-configs-new-upd/nginx" "$hosting_root/app-data/configs/nginx" "nginx.conf"
initialize_config "$project_dir/global-configs-new-upd/php-fpm" "$hosting_root/app-data/configs/php-fpm" "php-fpm.conf"
initialize_config "$project_dir/global-configs-new-upd/php" "$hosting_root/app-data/configs/php" "global.ini"
initialize_config "$project_dir/global-configs-new-upd/wp" "$hosting_root/app-data/configs/wp" "wp-global.php"

if [ -n "$php_global_ini_path" ] && [ ! -e "$php_global_ini_path" ]; then
  mkdir -p "$(dirname -- "$php_global_ini_path")"
  cp "$project_dir/global-configs-new-upd/php/global.ini" "$php_global_ini_path"
  chown 33:33 "$php_global_ini_path"
  chmod 640 "$php_global_ini_path"
fi

php_fpm_config="$hosting_root/app-data/configs/php-fpm/php-fpm.conf"
if ! grep -qxF 'include=/runtime-php-fpm/pools.conf' "$php_fpm_config"; then
  printf '\ninclude=/runtime-php-fpm/pools.conf\n' >> "$php_fpm_config"
fi

HOSTING_ROOT="$hosting_root" BACKUPS_DIR="$backups_dir" EXPORTS_DIR="$exports_dir" \
  sh "$project_dir/scripts/migrate-ui-permissions.sh"

cd "$project_dir"
compose config --quiet
compose build
if [ "$installation_role" = "standby" ]; then
  if [ "$tunnel_enabled" = true ]; then
    compose pull hosting-cloudflared
    compose up -d hosting-agent hosting-ui hosting-cloudflared hosting-sync
  else
    compose up -d hosting-agent hosting-ui hosting-sync
  fi
  echo "Standby installed. Writable and public origin services remain stopped."
else
  compose up -d
  if [ "$tunnel_enabled" = true ]; then
    compose pull hosting-cloudflared
    compose up -d hosting-cloudflared
  fi
fi

sh "$project_dir/scripts/stamp-source-release.sh"
sh "$project_dir/scripts/install-ha-panel-control.sh" --ui-data-dir "$ui_data_dir"
if [ "$installation_role" != "standby" ]; then
  compose exec -T hosting-ui node /app/cli/install-wordpress-cache-control.js \
    || echo "Warning: some existing WordPress cache-control installations need attention." >&2
fi
echo "Hosting stack installed. Existing persistent data and configuration were left unchanged."
