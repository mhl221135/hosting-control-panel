#!/bin/sh

set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run the panel-permissions migration as root." >&2
  exit 1
fi

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
panel_uid=33
panel_gid=33

env_value() {
  key="$1"
  [ -f "$env_file" ] || return 0
  awk -v key="$key" '
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

hosting_root="${HOSTING_ROOT:-$(env_value HOSTING_ROOT)}"
hosting_root="${hosting_root:-/media/ssdmount/websites-v2}"
backups_dir="${BACKUPS_DIR:-$(env_value BACKUPS_DIR)}"
backups_dir="${backups_dir:-$hosting_root/backups}"
exports_dir="${EXPORTS_DIR:-$(env_value EXPORTS_DIR)}"
exports_dir="${exports_dir:-$hosting_root/exports}"

assert_managed_path() {
  case "$1" in
    /*) ;;
    *) echo "Managed storage path must be absolute: $1" >&2; exit 1 ;;
  esac
  case "/$1/" in
    */../*|*/./*) echo "Managed storage path must be normalized: $1" >&2; exit 1 ;;
  esac
  case "$1" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/sys|/tmp|/usr|/var)
      echo "Refusing unsafe managed storage path: $1" >&2
      exit 1
      ;;
  esac
}

own_writable_tree() {
  target="$1"
  assert_managed_path "$target"
  mkdir -p "$target"
  find "$target" -xdev -exec chown -h "$panel_uid:$panel_gid" {} +
  find "$target" -xdev -type d -exec chmod u+rwx {} +
  find "$target" -xdev -type f -exec chmod u+rw {} +
}

grant_app_data_read() {
  target="$1"
  assert_managed_path "$target"
  mkdir -p "$target"
  find "$target" -xdev \
    \( -path "$target/mysql" -o -path "$target/nginx-cache" \) -prune -o \
    -exec chgrp -h "$panel_gid" {} +
  find "$target" -xdev \
    \( -path "$target/mysql" -o -path "$target/nginx-cache" \) -prune -o \
    -type d -exec chmod g+rX {} +
  find "$target" -xdev \
    \( -path "$target/mysql" -o -path "$target/nginx-cache" \) -prune -o \
    -type f -exec chmod g+r {} +
}

app_data="$hosting_root/app-data"
websites="$hosting_root/websites"
imports="$hosting_root/imports"

for path in "$hosting_root" "$app_data" "$websites" "$imports" "$backups_dir" "$exports_dir"; do
  assert_managed_path "$path"
done

mkdir -p \
  "$app_data/configs" \
  "$app_data/filebrowser" \
  "$app_data/ui-manager" \
  "$websites" \
  "$imports" \
  "$backups_dir" \
  "$exports_dir"

# App-data backups and NPM log statistics need read access. Database files and
# the disposable nginx cache remain excluded from both backup and panel access.
grant_app_data_read "$app_data"

own_writable_tree "$app_data/configs"
own_writable_tree "$app_data/filebrowser"
own_writable_tree "$app_data/ui-manager"
own_writable_tree "$backups_dir"
if [ "$exports_dir" != "$backups_dir" ]; then
  own_writable_tree "$exports_dir"
fi
own_writable_tree "$imports"

# Existing website ownership is intentionally preserved. UID 33 owns only the
# shared root so it can create, rename, and remove explicitly selected sites.
chown -h "$panel_uid:$panel_gid" "$websites"
chmod u+rwx "$websites"

echo "Panel storage permissions are ready for UID:GID $panel_uid:$panel_gid."
