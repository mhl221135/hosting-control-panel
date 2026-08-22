#!/bin/sh

set -eu

config=/etc/hosting-control/former-primary-fence.env
state=/etc/hosting-control/former-primary-fence-state.json
role_file=/etc/hosting-control/role.json

[ -f "$config" ] && [ ! -L "$config" ] || exit 0
[ "$(stat -c '%u' "$config" 2>/dev/null || true)" = 0 ] \
  && [ "$(stat -c '%a' "$config" 2>/dev/null || true)" = 600 ] || exit 1
# shellcheck disable=SC1090
. "$config"
[ "${FORMER_PRIMARY_FENCE_ENABLED:-false}" = true ] || exit 0
case "${FORMER_PRIMARY_PEER_HEALTH_URL:-}" in https://*) ;; *) exit 1 ;; esac
case "${FORMER_PRIMARY_PEER_SERVER_ID:-}" in ''|*[!A-Za-z0-9._-]*) exit 1 ;; esac
[ "$(jq -r '.role // empty' "$role_file" 2>/dev/null || true)" = primary ] || exit 0

response="$(curl -fsS --max-time 10 --connect-timeout 5 \
  "${FORMER_PRIMARY_PEER_HEALTH_URL}?former_primary_check=$(date -u +%s)" 2>/dev/null || true)"
printf '%s' "$response" | jq -e --arg peer "$FORMER_PRIMARY_PEER_SERVER_ID" '
  .ok == true and .role == "primary" and .serverId == $peer
  and (.failoverStatus | IN("promoted", "promoted-unreachable"))
  and (.recoveryId | type == "string")
' >/dev/null 2>&1 || exit 0

recovery_id="$(printf '%s' "$response" | jq -r .recoveryId)"
case "$recovery_id" in ????-??-??T??-??-??Z) ;; *) exit 1 ;; esac
temporary="$state.tmp.$$"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
write_state() {
  status="$1"
  jq -n --arg status "$status" --arg peer "$FORMER_PRIMARY_PEER_SERVER_ID" \
    --arg recovery_id "$recovery_id" --arg checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{version:1,status:$status,peerServerId:$peer,recoveryId:$recovery_id,checkedAt:$checked_at}' > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$state"
}

write_state fencing
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now hosting-database-replication.timer >/dev/null 2>&1 || true
  systemctl disable --now hosting-warm-sync-finalizer.timer >/dev/null 2>&1 || true
fi
containers="hosting-agent hosting-ui hosting-sync hosting-nginx hosting-php-fpm hosting-db hosting-redis hosting-billing hosting-files hosting-phpmyadmin"
# shellcheck disable=SC2086
docker stop $containers >/dev/null 2>&1 || true
running="$(docker ps --format '{{.Names}}' | awk '
  /^(hosting-agent|hosting-ui|hosting-sync|hosting-nginx|hosting-php-fpm|hosting-db|hosting-redis|hosting-billing|hosting-files|hosting-phpmyadmin)$/ { print }
')"
if [ -n "$running" ]; then
  write_state fence-failed
  printf 'Former-primary fence failed; writable containers remain: %s\n' "$running" >&2
  exit 1
fi
write_state fenced
trap - EXIT HUP INT TERM
printf 'Former primary fenced after peer %s promoted recovery %s. hosting-npm remains available for unrelated routes.\n' \
  "$FORMER_PRIMARY_PEER_SERVER_ID" "$recovery_id"
