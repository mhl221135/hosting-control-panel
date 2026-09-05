#!/bin/sh
set -eu
config=/etc/hosting-control/witness-primary.env
state=/etc/hosting-control/witness-primary-state.json
[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
[ -f "$config" ] && [ ! -L "$config" ] && [ "$(stat -c %u "$config")" = 0 ] \
  && [ "$(stat -c %a "$config")" = 600 ] || { printf 'Witness configuration is unsafe.\n' >&2; exit 1; }
# shellcheck disable=SC1090
. "$config"
token_file=${WITNESS_PRIMARY_TOKEN_FILE:-}
[ -f "$token_file" ] && [ ! -L "$token_file" ] && [ "$(stat -c %u "$token_file")" = 0 ] \
  && [ "$(stat -c %a "$token_file")" = 600 ] || { printf 'Witness token file is unsafe.\n' >&2; exit 1; }
role_file=/etc/hosting-control/role.json
[ "$(jq -r '.role // empty' "$role_file" 2>/dev/null || true)" = primary ] || exit 0
server_id="$(jq -er '.server_id' "$role_file")"
case "$server_id" in ''|*[!A-Za-z0-9._-]*) exit 1 ;; esac
temporary="$state.tmp.$$"
response="$state.response.$$"
headers="$state.headers.$$"
printf 'Authorization: Bearer %s\n' "$(cat "$token_file")" > "$headers"
chmod 600 "$headers"
trap 'rm -f "$temporary" "$response" "$headers"' EXIT HUP INT TERM
jq -nc --arg server "$server_id" '{version:1,primaryServerId:$server}' \
  | curl -fsS --max-time 10 --connect-timeout 5 --proto '=https' \
      -H @"$headers" -H 'Content-Type: application/json' \
      --data-binary @- "$WITNESS_LEASE_URL" > "$response"
[ "$(wc -c < "$response")" -le 4096 ] || exit 1
jq -e --arg server "$server_id" '
  .version == 1 and .status == "leased" and .primaryServerId == $server
  and (.leaseExpiresAt | fromdateiso8601) > now
' "$response" >/dev/null
jq --arg checked "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {checkedAt:$checked}' "$response" > "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$state"
trap - EXIT HUP INT TERM
rm -f "$response" "$headers"
