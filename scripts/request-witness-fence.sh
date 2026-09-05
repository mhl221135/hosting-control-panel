#!/bin/sh
set -eu
fail() { printf '%s\n' "$1" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail 'Run as root'
recovery_id=${1:-}
case "$recovery_id" in ????-??-??T??-??-??Z) ;; *) fail 'Recovery identifier is invalid' ;; esac
config=/etc/hosting-control/external-witness.env
[ -f "$config" ] && [ ! -L "$config" ] && [ "$(stat -c %u "$config")" = 0 ] \
  && [ "$(stat -c %a "$config")" = 600 ] || fail 'Witness configuration is unsafe'
# shellcheck disable=SC1090
. "$config"
for file in "$WITNESS_TOKEN_FILE" "$WITNESS_SIGNING_KEY_FILE"; do
  [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c %u "$file")" = 0 ] \
    && [ "$(stat -c %a "$file")" = 600 ] || fail 'Witness credential file is unsafe'
done
response=/etc/hosting-control/witness-response.$$
output=/etc/hosting-control/primary-fence-receipt.json
temporary="$output.tmp.$$"
headers=/etc/hosting-control/witness-headers.$$
printf 'Authorization: Bearer %s\n' "$(cat "$WITNESS_TOKEN_FILE")" > "$headers"
chmod 600 "$headers"
trap 'rm -f "$response" "$temporary" "$headers"' EXIT HUP INT TERM
jq -nc --arg server "$WITNESS_PRIMARY_SERVER_ID" --arg recovery "$recovery_id" \
  '{version:1,primaryServerId:$server,recoveryId:$recovery}' \
  | curl -fsS --max-time 15 --connect-timeout 5 --proto '=https' \
      -H @"$headers" -H 'Content-Type: application/json' \
      --data-binary @- "$WITNESS_URL" > "$response"
[ "$(wc -c < "$response")" -le 8192 ] || fail 'Witness response is too large'
jq -e --arg server "$WITNESS_PRIMARY_SERVER_ID" --arg recovery "$recovery_id" '
  .version == 1 and .status == "fenced" and .primaryServerId == $server and .recoveryId == $recovery
  and (.method | IN("power","network","service"))
  and (.nonce | type == "string" and test("^[A-Za-z0-9._~-]{16,128}$"))
  and (.signature | type == "string" and test("^[0-9a-f]{64}$"))
  and (.fencedAt | fromdateiso8601) <= (now + 30)
  and (.expiresAt | fromdateiso8601) > now
  and ((.expiresAt | fromdateiso8601) - (.fencedAt | fromdateiso8601)) <= 900
' "$response" >/dev/null || fail 'Witness receipt identity or fields are invalid'
canonical="$(jq -r '[.version,.status,.primaryServerId,.recoveryId,.method,.fencedAt,.expiresAt,.nonce] | join("|")' "$response")"
expected="$(printf '%s' "$canonical" | openssl dgst -sha256 -hmac "$(cat "$WITNESS_SIGNING_KEY_FILE")" -hex | awk '{print $NF}')"
supplied="$(jq -r '.signature' "$response")"
[ "$expected" = "$supplied" ] || fail 'Witness receipt signature is invalid'
jq '{version,status,primaryServerId,recoveryId,method,fencedAt,expiresAt,witnessNonce:.nonce}' "$response" > "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$output"
trap - EXIT HUP INT TERM
rm -f "$response" "$headers"
printf 'Verified external fencing receipt for %s at %s.\n' "$WITNESS_PRIMARY_SERVER_ID" "$recovery_id"
