#!/bin/sh
set -eu

config=/etc/hosting-control/witness-failback-reset.env
usage() { printf 'Usage: reset-witness-after-failback.sh PRIMARY_SERVER_ID\n' >&2; }
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
[ "$#" -eq 1 ] || { usage; exit 2; }
primary_id=$1
case "$primary_id" in ''|*[!A-Za-z0-9._-]*) usage; exit 2 ;; esac
[ -f "$config" ] && [ ! -L "$config" ] && [ "$(stat -c %u "$config")" = 0 ] \
  && [ "$(stat -c %a "$config")" = 600 ] \
  || { printf 'Witness failback reset is not configured safely.\n' >&2; exit 1; }
# shellcheck disable=SC1090
. "$config"
case "${WITNESS_RESET_URL:-}" in https://*/v1/reset) ;; *) exit 1 ;; esac
token_file=${WITNESS_RESET_TOKEN_FILE:-}
[ -f "$token_file" ] && [ ! -L "$token_file" ] && [ "$(stat -c %u "$token_file")" = 0 ] \
  && [ "$(stat -c %a "$token_file")" = 600 ] \
  || { printf 'Witness reset token is unavailable or unsafe.\n' >&2; exit 1; }

response=/etc/hosting-control/witness-reset-response.$$
headers=/etc/hosting-control/witness-reset-headers.$$
printf 'Authorization: Bearer %s\n' "$(cat "$token_file")" > "$headers"
chmod 600 "$headers"
trap 'rm -f "$response" "$headers"' EXIT HUP INT TERM
jq -nc --arg server "$primary_id" \
  '{version:1,primaryServerId:$server,confirm:"RESET-FENCING-WITNESS"}' \
  | curl --fail-with-body -sS --max-time 10 --connect-timeout 5 --proto '=https' \
      -H @"$headers" -H 'Content-Type: application/json' --data-binary @- \
      "$WITNESS_RESET_URL" > "$response"
[ "$(wc -c < "$response")" -le 4096 ] || exit 1
jq -e --arg server "$primary_id" \
  '.version == 1 and .status == "reset" and .primaryServerId == $server' "$response" >/dev/null
printf 'Independent witness reset for recovered primary %s.\n' "$primary_id"
