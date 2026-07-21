#!/bin/sh

set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
configure=false
requested_root=""

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
  if [ -n "$requested_root" ]; then
    "$project_dir/scripts/configure.sh" --root "$requested_root"
  else
    "$project_dir/scripts/configure.sh"
  fi
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

hosting_root="${requested_root:-${HOSTING_ROOT:-$(env_value HOSTING_ROOT)}}"
hosting_root="${hosting_root:-/media/ssdmount/websites-v2}"
backups_dir="${BACKUPS_DIR:-$(env_value BACKUPS_DIR)}"
backups_dir="${backups_dir:-$hosting_root/backups}"
exports_dir="${EXPORTS_DIR:-$(env_value EXPORTS_DIR)}"
exports_dir="${exports_dir:-$hosting_root/exports}"

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

for variable in UI_ADMIN_PASSWORD NPM_SECRET FILEBROWSER_ADMIN_PASSWORD MYSQL_ROOT_PASSWORD NPM_DB_PASSWORD; do
  value="$(env_value "$variable")"
  if [ "${#value}" -lt 12 ]; then
    echo "$variable must contain at least 12 characters." >&2
    exit 1
  fi
done

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
  "$hosting_root/app-data/configs" \
  "$hosting_root/app-data/filebrowser/config" \
  "$hosting_root/app-data/filebrowser/database" \
  "$hosting_root/app-data/mysql" \
  "$hosting_root/app-data/nginx-cache" \
  "$hosting_root/app-data/npm/data" \
  "$hosting_root/app-data/npm/letsencrypt" \
  "$hosting_root/app-data/redis" \
  "$hosting_root/app-data/ui-manager" \
  "$backups_dir/app-data" \
  "$exports_dir" \
  "$hosting_root/imports" \
  "$hosting_root/websites/_default"

chown -R 33:33 \
  "$hosting_root/app-data/filebrowser" \
  "$hosting_root/websites"

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

cd "$project_dir"
compose config --quiet
compose build
compose up -d

echo "Hosting stack installed. Existing persistent data and configuration were left unchanged."
