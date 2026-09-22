#!/bin/sh
set -eu

usage() { printf 'Usage: install-witness-failback-reset.sh --url HTTPS_URL --token-file PATH\n' >&2; }
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
url= token_file=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) shift; url=${1:-} ;;
    --token-file) shift; token_file=${1:-} ;;
    *) usage; exit 2 ;;
  esac
  shift
done
case "$url" in https://*/v1/reset) ;; *) usage; exit 2 ;; esac
case "$token_file" in /*) ;; *) usage; exit 2 ;; esac
[ -f "$token_file" ] && [ ! -L "$token_file" ] && [ "$(stat -c %u "$token_file")" = 0 ] \
  && [ "$(stat -c %a "$token_file")" = 600 ] \
  || { printf 'Witness reset token must be a root-owned mode-600 regular file.\n' >&2; exit 1; }

install -d -m 700 /etc/hosting-control
temporary=/etc/hosting-control/witness-failback-reset.env.tmp.$$
umask 077
{
  printf "WITNESS_RESET_URL='%s'\n" "$url"
  printf "WITNESS_RESET_TOKEN_FILE='%s'\n" "$token_file"
} > "$temporary"
mv "$temporary" /etc/hosting-control/witness-failback-reset.env
chmod 0755 "$(dirname "$0")/reset-witness-after-failback.sh"
printf 'Witness failback reset configured.\n'
