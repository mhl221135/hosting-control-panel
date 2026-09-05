#!/bin/sh
set -eu
state=/etc/hosting-control/witness-primary-state.json
role=/etc/hosting-control/role.json
[ "$(jq -r '.role // empty' "$role" 2>/dev/null || true)" = primary ] || exit 0
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
if node "$project_dir/scripts/witness-primary-lease.js"; then exit 0; fi
[ -f "$state" ] && [ ! -L "$state" ] || exit 1
expires="$(jq -r '.leaseExpiresAt // empty' "$state")"
expires_epoch="$(date -u -d "$expires" +%s 2>/dev/null || printf 0)"
[ "$expires_epoch" -gt 0 ] || exit 1
[ "$(date -u +%s)" -lt "$expires_epoch" ] && exit 1

systemctl disable --now hosting-witness-primary.timer hosting-database-replication.timer hosting-warm-sync-finalizer.timer >/dev/null 2>&1 || true
docker stop hosting-agent hosting-ui hosting-sync hosting-nginx hosting-php-fpm hosting-db hosting-redis hosting-billing hosting-files hosting-phpmyadmin >/dev/null 2>&1 || true
running="$(docker ps --format '{{.Names}}' | awk '/^(hosting-agent|hosting-ui|hosting-sync|hosting-nginx|hosting-php-fpm|hosting-db|hosting-redis|hosting-billing|hosting-files|hosting-phpmyadmin)$/')"
[ -z "$running" ] || { printf 'Witness lease expired but writable containers remain: %s\n' "$running" >&2; exit 1; }
temporary=/etc/hosting-control/witness-primary-fenced.json.tmp.$$
jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg expired "$expires" \
  '{version:1,status:"self-fenced",fencedAt:$at,leaseExpiredAt:$expired}' > "$temporary"
chmod 600 "$temporary"
mv "$temporary" /etc/hosting-control/witness-primary-fenced.json
printf 'Primary self-fenced because its independent witness lease expired. hosting-npm remains available.\n'
