#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$project_dir/.env"
apply=false
nginx_stopped=false
rotation_started=false
env_backup=""
temporary_files=()

usage() {
  cat <<'EOF'
Usage: sudo ./scripts/rotate-credentials.sh --apply

Interactively rotates local stack passwords and optionally every WordPress
database user. Run it from the installed source tree during maintenance.

This does not rotate Cloudflare tokens, TLS/ACME keys, WordPress administrator
passwords, or UI_SETTINGS_KEY.
EOF
}

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$rotation_started" = true ]; then
    printf '\nCredential rotation stopped after maintenance began.\n' >&2
    printf 'hosting-nginx is being left stopped to avoid serving a partially updated stack.\n' >&2
    if [ -n "$env_backup" ] && [ -f "$env_backup" ]; then
      recovery_env="$project_dir/.env.rotation-failed.$(date -u +%Y%m%dT%H%M%SZ)"
      cp -p "$env_backup" "$recovery_env"
      chmod 600 "$recovery_env"
      printf 'The pre-rotation environment was preserved at %s. Delete it after recovery.\n' "$recovery_env" >&2
    fi
  fi
  for file in "${temporary_files[@]:-}"; do
    [ -n "$file" ] && rm -f -- "$file"
  done
  if [ "$status" -eq 0 ] && [ "$nginx_stopped" = true ]; then
    docker start hosting-nginx >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

if [ "$apply" != true ]; then
  usage
  printf '\nNo changes made. Pass --apply to enter the maintenance workflow.\n'
  exit 0
fi
if [ "$(id -u)" -ne 0 ]; then
  printf 'Run this command as root.\n' >&2
  exit 1
fi
if [ ! -f "$env_file" ]; then
  printf '%s is missing. Run this from an installed stack.\n' "$env_file" >&2
  exit 1
fi

for command in docker curl jq openssl awk find; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Required command is missing: %s\n' "$command" >&2
    exit 1
  }
done

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  printf 'Docker Compose is required.\n' >&2
  exit 1
fi

# The installer writes shell-safe single-quoted values. Do not print them.
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

required_variables=(
  HOSTING_ROOT UI_ADMIN_EMAIL UI_ADMIN_PASSWORD NPM_IDENTITY NPM_SECRET
  FILEBROWSER_ADMIN_USERNAME FILEBROWSER_ADMIN_PASSWORD MYSQL_ROOT_PASSWORD
  NPM_DB_USER NPM_DB_PASSWORD NPM_DB_NAME
)
for variable in "${required_variables[@]}"; do
  if [ -z "${!variable:-}" ]; then
    printf '%s is missing from .env.\n' "$variable" >&2
    exit 1
  fi
done

validate_password() {
  local value="$1"
  if [ "${#value}" -lt 12 ] || [ "${#value}" -gt 64 ]; then
    printf 'Passwords must contain 12 to 64 characters.\n' >&2
    return 1
  fi
  case "$value" in
    *"'"*|*\\*)
      printf "Passwords containing a single quote or backslash are not supported by the dotenv updater.\n" >&2
      return 1
      ;;
  esac
}

prompt_password() {
  local label="$1" first second
  while :; do
    read -r -s -p "$label: " first </dev/tty
    printf '\n' >/dev/tty
    read -r -s -p "Repeat $label: " second </dev/tty
    printf '\n' >/dev/tty
    if [ "$first" != "$second" ]; then
      printf 'Passwords do not match.\n' >/dev/tty
      continue
    fi
    if validate_password "$first"; then
      REPLY="$first"
      return
    fi
  done
}

prompt_current_password() {
  local label="$1"
  read -r -s -p "$label: " REPLY </dev/tty
  printf '\n' >/dev/tty
  [ -n "$REPLY" ] || { printf 'A current password is required.\n' >&2; exit 1; }
}

dotenv_set() {
  local key="$1" value="$2" temporary
  case "$value" in
    *"'"*|*\\*|*$'\n'*|*$'\r'*)
      printf 'Cannot safely store %s in dotenv format.\n' "$key" >&2
      return 1
      ;;
  esac
  temporary="$(mktemp "$project_dir/.env.rotate.XXXXXX")"
  temporary_files+=("$temporary")
  awk -v key="$key" -v replacement="$key='$value'" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 { print replacement; replaced = 1; next }
    { print }
    END { if (!replaced) print replacement }
  ' "$env_file" >"$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$env_file"
}

mysql_current() {
  docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" hosting-db \
    mysql --protocol=socket -uroot --batch --skip-column-names "$@"
}

mysql_new() {
  docker exec -i -e MYSQL_PWD="$new_mysql_root_password" hosting-db \
    mysql --protocol=socket -uroot --batch --skip-column-names "$@"
}

npm_token() {
  local identity="$1" secret="$2"
  curl -fsS "${NPM_ROTATION_API_URL:-http://127.0.0.1:81/api}/tokens" \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg identity "$identity" --arg secret "$secret" '{identity:$identity,secret:$secret}')" \
    | jq -er '.token'
}

verify_panel_password() {
  local password="$1"
  docker exec -e ROTATION_PASSWORD="$password" hosting-ui node -e '
    const { AuthStore } = require("/app/lib/auth");
    const store = new AuthStore("/app/data");
    const account = store.readAccount();
    store.login({ headers: {}, socket: { remoteAddress: "credential-rotation" } }, account.email, process.env.ROTATION_PASSWORD);
  ' >/dev/null
}

update_panel_password() {
  docker exec \
    -e ROTATION_CURRENT_PASSWORD="$current_ui_password" \
    -e ROTATION_NEW_PASSWORD="$new_ui_password" \
    hosting-ui node -e '
      const { AuthStore } = require("/app/lib/auth");
      const store = new AuthStore("/app/data");
      const account = store.readAccount();
      store.updateAccount(
        { email: account.email, csrf: "" },
        process.env.ROTATION_CURRENT_PASSWORD,
        account.email,
        process.env.ROTATION_NEW_PASSWORD,
      );
    '
}

update_panel_npm_secret() {
  docker exec -e ROTATION_NPM_SECRET="$new_npm_password" hosting-ui node -e '
    const { IntegrationSettings } = require("/app/lib/integration-settings");
    const settings = new IntegrationSettings("/app/data");
    settings.update({ npmSecret: process.env.ROTATION_NPM_SECRET });
  ' >/dev/null
}

random_site_password() {
  openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n' | cut -c1-40
}

rotate_site_database_users() {
  local config relative site_path database user old_password new_password hosts host sql
  local -A password_by_user=()
  local count=0
  mapfile -d '' site_configs < <(
    find "$HOSTING_ROOT/websites" -mindepth 2 -maxdepth 2 -type f -name wp-config.php -print0 | sort -z
  )

  for config in "${site_configs[@]}"; do
    relative="${config#"$HOSTING_ROOT/websites/"}"
    relative="${relative%/wp-config.php}"
    site_path="/var/www/$relative"
    database="$(docker exec hosting-php-fpm wp --allow-root config get DB_NAME --type=constant --path="$site_path" --quiet)"
    user="$(docker exec hosting-php-fpm wp --allow-root config get DB_USER --type=constant --path="$site_path" --quiet)"
    old_password="$(docker exec hosting-php-fpm wp --allow-root config get DB_PASSWORD --type=constant --path="$site_path" --quiet)"
    if [[ ! "$database" =~ ^[A-Za-z0-9_$-]{1,64}$ ]] || [[ ! "$user" =~ ^[A-Za-z0-9_$-]{1,64}$ ]]; then
      printf 'Refusing invalid database identity for %s.\n' "$relative" >&2
      return 1
    fi
    if [ "$user" = root ] || [ "$user" = "$NPM_DB_USER" ]; then
      printf 'Refusing reserved MySQL account %s in %s.\n' "$user" "$relative" >&2
      return 1
    fi

    if [ -n "${password_by_user[$user]:-}" ]; then
      new_password="${password_by_user[$user]}"
      docker exec hosting-php-fpm wp --allow-root config set DB_PASSWORD "$new_password" \
        --type=constant --path="$site_path" --quiet >/dev/null
      count=$((count + 1))
      printf 'Updated shared database credential for %s.\n' "$relative"
      continue
    fi

    new_password="$(random_site_password)"
    hosts="$(mysql_current -e "SELECT Host FROM mysql.user WHERE User='$user' ORDER BY Host")"
    if [ -z "$hosts" ]; then
      printf 'No MySQL account exists for site user %s.\n' "$user" >&2
      return 1
    fi

    docker exec hosting-php-fpm wp --allow-root config set DB_PASSWORD "$new_password" \
      --type=constant --path="$site_path" --quiet >/dev/null
    sql=""
    while IFS= read -r host; do
      [[ "$host" =~ ^[A-Za-z0-9.%:_-]+$ ]] || {
        docker exec hosting-php-fpm wp --allow-root config set DB_PASSWORD "$old_password" \
          --type=constant --path="$site_path" --quiet >/dev/null || true
        printf 'Refusing unexpected MySQL host value for %s.\n' "$user" >&2
        return 1
      }
      sql+="ALTER USER '$user'@'$host' IDENTIFIED BY '$new_password';"
    done <<<"$hosts"
    if ! mysql_current -e "$sql"; then
      docker exec hosting-php-fpm wp --allow-root config set DB_PASSWORD "$old_password" \
        --type=constant --path="$site_path" --quiet >/dev/null || true
      return 1
    fi
    password_by_user[$user]="$new_password"
    count=$((count + 1))
    printf 'Rotated database credential for %s.\n' "$relative"
  done
  printf 'Updated %d WordPress configuration(s).\n' "$count"
}

rotate_mysql_service_users() {
  local npm_hosts root_hosts host sql_file
  sql_file="$(mktemp /tmp/hosting-credential-sql.XXXXXX)"
  temporary_files+=("$sql_file")
  npm_hosts="$(mysql_current -e "SELECT Host FROM mysql.user WHERE User='$NPM_DB_USER' ORDER BY Host")"
  root_hosts="$(mysql_current -e "SELECT Host FROM mysql.user WHERE User='root' ORDER BY Host")"
  [ -n "$npm_hosts" ] || { printf 'NPM database user does not exist.\n' >&2; return 1; }
  [ -n "$root_hosts" ] || { printf 'MySQL root account does not exist.\n' >&2; return 1; }

  while IFS= read -r host; do
    [[ "$host" =~ ^[A-Za-z0-9.%:_-]+$ ]] || return 1
    printf "ALTER USER '%s'@'%s' IDENTIFIED BY '%s';\n" "$NPM_DB_USER" "$host" "$new_npm_db_password" >>"$sql_file"
  done <<<"$npm_hosts"
  while IFS= read -r host; do
    [[ "$host" =~ ^[A-Za-z0-9.%:_-]+$ ]] || return 1
    printf "ALTER USER 'root'@'%s' IDENTIFIED BY '%s';\n" "$host" "$new_mysql_root_password" >>"$sql_file"
  done <<<"$root_hosts"
  printf 'FLUSH PRIVILEGES;\n' >>"$sql_file"
  mysql_current <"$sql_file"
}

wait_for_mysql() {
  local _
  for _ in $(seq 1 60); do
    if mysql_new -e 'SELECT 1' >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  printf 'MySQL did not become ready with the rotated password.\n' >&2
  return 1
}

prompt_current_password 'Current panel password'
current_ui_password="$REPLY"
prompt_password 'New panel password'
new_ui_password="$REPLY"
prompt_current_password 'Current NPM administrator password'
current_npm_password="$REPLY"
prompt_password 'New NPM administrator password'
new_npm_password="$REPLY"
prompt_password 'New File Browser administrator password'
new_filebrowser_password="$REPLY"
prompt_password 'New MySQL root password'
new_mysql_root_password="$REPLY"
prompt_password 'New NPM database password'
new_npm_db_password="$REPLY"

read -r -p 'Rotate every WordPress database user and wp-config.php? [Y/n]: ' rotate_sites </dev/tty
case "${rotate_sites:-Y}" in [Nn]*) rotate_sites=false ;; *) rotate_sites=true ;; esac
read -r -p 'Type ROTATE to begin the maintenance window: ' confirmation </dev/tty
[ "$confirmation" = ROTATE ] || { printf 'Cancelled.\n'; exit 1; }

cd "$project_dir"
compose config --quiet
for container in hosting-ui hosting-npm hosting-files hosting-db hosting-php-fpm hosting-nginx; do
  [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" = true ] || {
    printf 'Required container is not running: %s\n' "$container" >&2
    exit 1
  }
done

printf 'Validating current credentials...\n'
verify_panel_password "$current_ui_password"
npm_token "$NPM_IDENTITY" "$current_npm_password" >/dev/null
mysql_current -e 'SELECT 1' >/dev/null
docker exec hosting-files filebrowser -d /database/filebrowser.db users ls \
  | awk -v user="$FILEBROWSER_ADMIN_USERNAME" '$0 ~ user { found=1 } END { exit !found }'

env_backup="$(mktemp /tmp/hosting-env-before-rotation.XXXXXX)"
temporary_files+=("$env_backup")
cp -p "$env_file" "$env_backup"

printf 'Stopping public internal nginx for maintenance...\n'
docker stop hosting-nginx >/dev/null
nginx_stopped=true
rotation_started=true

if [ "$rotate_sites" = true ]; then
  rotate_site_database_users
fi

printf 'Rotating NPM administrator password...\n'
old_npm_token="$(npm_token "$NPM_IDENTITY" "$current_npm_password")"
curl -fsS -X PUT "${NPM_ROTATION_API_URL:-http://127.0.0.1:81/api}/users/me/auth" \
  -H "Authorization: Bearer $old_npm_token" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg current "$current_npm_password" --arg secret "$new_npm_password" \
    '{type:"password",current:$current,secret:$secret}')" >/dev/null
npm_token "$NPM_IDENTITY" "$new_npm_password" >/dev/null
unset old_npm_token

printf 'Rotating panel and File Browser passwords...\n'
update_panel_password
docker exec hosting-files filebrowser -d /database/filebrowser.db users update \
  "$FILEBROWSER_ADMIN_USERNAME" --password "$new_filebrowser_password" >/dev/null
update_panel_npm_secret

printf 'Rotating MySQL service credentials...\n'
rotate_mysql_service_users

dotenv_set UI_ADMIN_PASSWORD "$new_ui_password"
dotenv_set NPM_SECRET "$new_npm_password"
dotenv_set FILEBROWSER_ADMIN_PASSWORD "$new_filebrowser_password"
dotenv_set MYSQL_ROOT_PASSWORD "$new_mysql_root_password"
dotenv_set NPM_DB_PASSWORD "$new_npm_db_password"
chmod 600 "$env_file"

printf 'Recreating services with rotated environment values...\n'
compose config --quiet
compose up -d --force-recreate hosting-db
wait_for_mysql
compose up -d --force-recreate hosting-npm hosting-phpmyadmin hosting-ui hosting-files
compose up -d hosting-php-fpm
docker start hosting-nginx >/dev/null
nginx_stopped=false

printf 'Validating rotated credentials...\n'
verify_panel_password "$new_ui_password"
npm_token "$NPM_IDENTITY" "$new_npm_password" >/dev/null
mysql_new -e 'SELECT 1' >/dev/null
if [ "$rotate_sites" = true ]; then
  while IFS= read -r -d '' config; do
    relative="${config#"$HOSTING_ROOT/websites/"}"
    relative="${relative%/wp-config.php}"
    docker exec hosting-php-fpm wp --allow-root db check --path="/var/www/$relative" --quiet >/dev/null
  done < <(find "$HOSTING_ROOT/websites" -mindepth 2 -maxdepth 2 -type f -name wp-config.php -print0)
fi

printf '\nCredential rotation completed. Existing panel sessions were invalidated by restart.\n'
printf 'Revoke and replace Cloudflare tokens separately, then update Settings in the panel.\n'
