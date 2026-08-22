#!/bin/sh
set -eu
usage() { printf 'Usage: install-external-witness.sh --url HTTPS_URL --token-file PATH --signing-key-file PATH --primary-server-id ID\n' >&2; }
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
url= token_file= signing_key_file= primary_id=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) shift; url=${1:-} ;; --token-file) shift; token_file=${1:-} ;;
    --signing-key-file) shift; signing_key_file=${1:-} ;; --primary-server-id) shift; primary_id=${1:-} ;;
    *) usage; exit 2 ;;
  esac
  shift
done
case "$url" in https://*) ;; *) usage; exit 2 ;; esac
case "$token_file:$signing_key_file" in /*:/*) ;; *) usage; exit 2 ;; esac
case "$primary_id" in ''|*[!A-Za-z0-9._-]*) usage; exit 2 ;; esac
for file in "$token_file" "$signing_key_file"; do
  [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c %u "$file")" = 0 ] && [ "$(stat -c %a "$file")" = 600 ] \
    || { printf '%s must be a root-owned mode-600 regular file.\n' "$file" >&2; exit 1; }
done
umask 077
temporary=/etc/hosting-control/external-witness.env.tmp.$$
{
  printf "WITNESS_URL='%s'\n" "$url"
  printf "WITNESS_TOKEN_FILE='%s'\n" "$token_file"
  printf "WITNESS_SIGNING_KEY_FILE='%s'\n" "$signing_key_file"
  printf "WITNESS_PRIMARY_SERVER_ID='%s'\n" "$primary_id"
} > "$temporary"
mv "$temporary" /etc/hosting-control/external-witness.env
chmod 0755 "$(dirname "$0")/request-witness-fence.js"
printf 'External witness client configured; no fencing request was sent.\n'
