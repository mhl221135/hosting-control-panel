#!/bin/sh

set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
hosting_root=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      shift
      [ "$#" -gt 0 ] || { echo "--root requires a directory." >&2; exit 1; }
      hosting_root="$1"
      ;;
    *)
      echo "Unknown configuration option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

exec 3<&0 4>&1
temporary=""
cleanup() {
  stty echo <&3 2>/dev/null || true
  [ -z "$temporary" ] || rm -f "$temporary"
}
trap cleanup EXIT HUP INT TERM

prompt() {
  label="$1"
  default="${2:-}"
  if [ -n "$default" ]; then
    printf "%s [%s]: " "$label" "$default" >&4
  else
    printf "%s: " "$label" >&4
  fi
  IFS= read -r answer <&3
  ANSWER="${answer:-$default}"
}

prompt_required() {
  while :; do
    prompt "$1" "${2:-}"
    [ -n "$ANSWER" ] && return
    printf "A value is required.\n" >&4
  done
}

prompt_password() {
  label="$1"
  while :; do
    printf "%s (minimum 12 characters): " "$label" >&4
    stty -echo <&3
    IFS= read -r first <&3
    stty echo <&3
    printf "\nRepeat %s: " "$label" >&4
    stty -echo <&3
    IFS= read -r second <&3
    stty echo <&3
    printf "\n" >&4
    if [ "$first" != "$second" ]; then
      printf "Passwords do not match.\n" >&4
    elif [ "${#first}" -lt 12 ]; then
      printf "Password must contain at least 12 characters.\n" >&4
    else
      ANSWER="$first"
      return
    fi
  done
}

dotenv_value() {
  value="$1"
  case "$value" in
    *"'"*)
      printf "Values containing a single quote are not supported by this installer.\n" >&4
      exit 1
      ;;
  esac
  printf "'%s'" "$value"
}

if [ -z "$hosting_root" ]; then
  prompt_required "Installation root" "/media/ssdmount/websites-v2"
  hosting_root="$ANSWER"
fi
case "$hosting_root" in
  /*) ;;
  *) printf "Installation root must be an absolute path.\n" >&4; exit 1 ;;
esac

prompt_required "Panel administrator email"
ui_admin_email="$ANSWER"
prompt_password "Panel administrator password"
ui_admin_password="$ANSWER"

prompt_required "Nginx Proxy Manager administrator email" "$ui_admin_email"
npm_identity="$ANSWER"
prompt_password "Nginx Proxy Manager administrator password"
npm_secret="$ANSWER"

prompt_required "ACME certificate email" "$ui_admin_email"
acme_email="$ANSWER"
prompt_required "File Browser administrator username" "file-admin"
filebrowser_username="$ANSWER"
prompt_password "File Browser administrator password"
filebrowser_password="$ANSWER"

prompt_password "MySQL root password"
mysql_root_password="$ANSWER"
prompt_required "NPM database username" "npm_db"
npm_db_user="$ANSWER"
prompt_password "NPM database password"
npm_db_password="$ANSWER"
prompt_required "NPM database name" "npm_db"
npm_db_name="$ANSWER"
prompt_required "New website database prefix" "yogali00_"
mysql_site_prefix="$ANSWER"

prompt "Cloudflare API token (optional)"
cloudflare_token="$ANSWER"
prompt "Cloudflare Security API token (optional, Rulesets/WAF write)"
cloudflare_security_token="$ANSWER"
prompt "Cloudflare account ID (optional)"
cloudflare_account_id="$ANSWER"

if command -v openssl >/dev/null 2>&1; then
  ui_settings_key="$(openssl rand -hex 32)"
else
  ui_settings_key="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
fi

umask 077
temporary="$env_file.tmp.$$"
{
  printf "HOSTING_ROOT=%s\n\n" "$(dotenv_value "$hosting_root")"
  printf "UI_ADMIN_EMAIL=%s\n" "$(dotenv_value "$ui_admin_email")"
  printf "UI_ADMIN_PASSWORD=%s\n" "$(dotenv_value "$ui_admin_password")"
  printf "UI_SETTINGS_KEY=%s\n\n" "$(dotenv_value "$ui_settings_key")"
  printf "NPM_API_URL='http://hosting-npm:81/api'\n"
  printf "NPM_IDENTITY=%s\n" "$(dotenv_value "$npm_identity")"
  printf "NPM_SECRET=%s\n" "$(dotenv_value "$npm_secret")"
  printf "ACME_EMAIL=%s\n\n" "$(dotenv_value "$acme_email")"
  printf "FILEBROWSER_ADMIN_USERNAME=%s\n" "$(dotenv_value "$filebrowser_username")"
  printf "FILEBROWSER_ADMIN_PASSWORD=%s\n\n" "$(dotenv_value "$filebrowser_password")"
  printf "CLOUDFLARE_API_TOKEN=%s\n" "$(dotenv_value "$cloudflare_token")"
  printf "CLOUDFLARE_SECURITY_API_TOKEN=%s\n" "$(dotenv_value "$cloudflare_security_token")"
  printf "CLOUDFLARE_ACCOUNT_ID=%s\n\n" "$(dotenv_value "$cloudflare_account_id")"
  printf "MYSQL_SITE_PREFIX=%s\n" "$(dotenv_value "$mysql_site_prefix")"
  printf "MYSQL_ROOT_PASSWORD=%s\n" "$(dotenv_value "$mysql_root_password")"
  printf "NPM_DB_USER=%s\n" "$(dotenv_value "$npm_db_user")"
  printf "NPM_DB_PASSWORD=%s\n" "$(dotenv_value "$npm_db_password")"
  printf "NPM_DB_NAME=%s\n" "$(dotenv_value "$npm_db_name")"
} > "$temporary"
mv "$temporary" "$env_file"
temporary=""
trap - EXIT HUP INT TERM

printf "Configuration written to %s.\n" "$env_file" >&4
