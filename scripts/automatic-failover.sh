#!/bin/bash

set -euo pipefail

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
config=/etc/hosting-control/automatic-failover.env
state=/etc/hosting-control/automatic-failover-state.json
lock=/run/hosting-automatic-failover.lock

[ -f "$config" ] || exit 0
# The file is root-owned mode 0600 and written by install-automatic-failover.sh.
# shellcheck disable=SC1090
. "$config"

write_state() {
  state_status="$1"
  state_failures="$2"
  state_recovery_id="${3:-}"
  state_unreachable_since="${4:-}"
  state_recovery_age="${5:-}"
  temporary="$state.tmp.$$"
  jq -n --arg checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg status "$state_status" --arg recovery_id "$state_recovery_id" \
    --arg unreachable_since "$state_unreachable_since" \
    --arg recovery_age "$state_recovery_age" \
    --arg fence_policy "${AUTO_FAILOVER_FENCE_POLICY:-receipt}" \
    --argjson failures "$state_failures" --argjson threshold "$AUTO_FAILOVER_FAILURES" \
    '{version:1,checkedAt:$checked_at,status:$status,failures:$failures,threshold:$threshold,fencePolicy:$fence_policy}
     + (if $recovery_id == "" then {} else {recoveryId:$recovery_id} end)
     + (if $unreachable_since == "" then {} else {unreachableSince:$unreachable_since} end)
     + (if $recovery_age == "" then {} else {recoveryAgeSeconds:($recovery_age | tonumber)} end)' > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$state"
  public_state="${AUTO_FAILOVER_PUBLIC_STATE_FILE:-$project_dir/../app-data/ui-manager/automatic-failover-state.json}"
  public_dir="$(dirname -- "$public_state")"
  if [ -d "$public_dir" ] && [ ! -L "$public_dir" ]; then
    public_temporary="$public_state.tmp.$$"
    if cp "$state" "$public_temporary" && chmod 644 "$public_temporary" \
      && mv "$public_temporary" "$public_state"; then
      :
    else
      rm -f "$public_temporary"
      printf 'Warning: automatic failover panel status could not be published.\n' >&2
    fi
  fi
}

write_inventory_state() {
  public_state="${AUTO_FAILOVER_PUBLIC_STATE_FILE:-$project_dir/../app-data/ui-manager/automatic-failover-state.json}"
  public_dir="$(dirname -- "$public_state")"
  output="$public_dir/failover-inventory.json"
  candidates="${AUTO_FAILOVER_CANDIDATES_FILE:-/etc/hosting-control/failover-hosts.candidates.txt}"
  metadata="${candidates%.txt}.json"
  active="${AUTO_FAILOVER_HOSTS_FILE:-}"
  temporary="$output.tmp.$$"
  additions="$(mktemp)"
  removals="$(mktemp)"
  trap 'rm -f "$temporary" "$additions" "$removals"' RETURN
  available=false
  if [ -d "$public_dir" ] && [ ! -L "$public_dir" ] \
    && [ -f "$candidates" ] && [ ! -L "$candidates" ] \
    && [ -f "$metadata" ] && [ ! -L "$metadata" ] \
    && [ -f "$active" ] && [ ! -L "$active" ] \
    && LC_ALL=C sort -c -u "$candidates" >/dev/null 2>&1 \
    && LC_ALL=C sort -c -u "$active" >/dev/null 2>&1; then
    candidate_count="$(wc -l < "$candidates" | tr -d ' ')"
    active_count="$(wc -l < "$active" | tr -d ' ')"
    candidate_sha="$(sha256sum "$candidates" | awk '{print $1}')"
    if jq -e --arg sha "$candidate_sha" --argjson count "$candidate_count" \
      '.version == 1 and .sha256 == $sha and .count == $count and .count > 0 and .count <= 5000' \
      "$metadata" >/dev/null 2>&1; then
      LC_ALL=C comm -13 "$active" "$candidates" > "$additions"
      LC_ALL=C comm -23 "$active" "$candidates" > "$removals"
      addition_count="$(wc -l < "$additions" | tr -d ' ')"
      removal_count="$(wc -l < "$removals" | tr -d ' ')"
      additions_json="$(sed -n '1,100p' "$additions" | jq -Rsc 'split("\n") | map(select(length > 0))')"
      removals_json="$(sed -n '1,100p' "$removals" | jq -Rsc 'split("\n") | map(select(length > 0))')"
      recovery_id="$(jq -r '.recovery_id // empty' "$metadata")"
      jq -n --arg recovery_id "$recovery_id" --argjson candidate_count "$candidate_count" \
        --argjson active_count "$active_count" --argjson addition_count "$addition_count" \
        --argjson removal_count "$removal_count" --argjson additions "$additions_json" \
        --argjson removals "$removals_json" \
        '{version:1,available:true,recoveryId:$recovery_id,candidateCount:$candidate_count,
          activeCount:$active_count,pendingAdditionCount:$addition_count,pendingRemovalCount:$removal_count,
          additions:$additions,removals:$removals,truncated:($addition_count > 100 or $removal_count > 100)}' > "$temporary"
      available=true
    fi
  fi
  if [ "$available" = false ] && [ -d "$public_dir" ] && [ ! -L "$public_dir" ]; then
    printf '%s\n' '{"version":1,"available":false}' > "$temporary"
  fi
  if [ -f "$temporary" ]; then chmod 644 "$temporary"; mv "$temporary" "$output"; fi
  rm -f "$additions" "$removals"
  trap - RETURN
}

valid_fence_receipt() {
  receipt="${AUTO_FAILOVER_FENCE_RECEIPT:-/etc/hosting-control/primary-fence-receipt.json}"
  [ -f "$receipt" ] && [ ! -L "$receipt" ] || return 1
  [ "$(stat -c '%u' "$receipt" 2>/dev/null || true)" = 0 ] || return 1
  [ "$(stat -c '%a' "$receipt" 2>/dev/null || true)" = 600 ] || return 1
  jq -e --arg primary "${AUTO_FAILOVER_PRIMARY_SERVER_ID:-}" --arg recovery "$1" \
    --argjson max_age "${AUTO_FAILOVER_FENCE_MAX_AGE_SECONDS:-900}" '
      .version == 1 and .status == "fenced"
      and .primaryServerId == $primary and .recoveryId == $recovery
      and (.method | IN("power", "network", "service"))
      and ((.fencedAt | fromdateiso8601) <= (now + 30))
      and ((now - (.fencedAt | fromdateiso8601)) <= $max_age)
      and ((.expiresAt | fromdateiso8601) >= now)
    ' "$receipt" >/dev/null 2>&1
}

valid_host_qualification() {
  receipt="${AUTO_FAILOVER_QUALIFICATION_RECEIPT:-/etc/hosting-control/failover-hosts.qualification.json}"
  hosts="${AUTO_FAILOVER_HOSTS_FILE:-}"
  candidates="${AUTO_FAILOVER_CANDIDATES_FILE:-/etc/hosting-control/failover-hosts.candidates.txt}"
  metadata="${candidates%.txt}.json"
  [ -f "$receipt" ] && [ ! -L "$receipt" ] || return 1
  [ -f "$hosts" ] && [ ! -L "$hosts" ] || return 1
  [ -f "$candidates" ] && [ ! -L "$candidates" ] || return 1
  [ -f "$metadata" ] && [ ! -L "$metadata" ] || return 1
  [ "$(stat -c '%u' "$receipt" 2>/dev/null || true)" = 0 ] || return 1
  [ "$(stat -c '%a' "$receipt" 2>/dev/null || true)" = 600 ] || return 1
  LC_ALL=C sort -c -u "$hosts" >/dev/null 2>&1 || return 1
  LC_ALL=C sort -c -u "$candidates" >/dev/null 2>&1 || return 1
  host_count="$(wc -l < "$hosts" | tr -d ' ')"
  host_sha="$(sha256sum "$hosts" | awk '{print $1}')"
  candidate_count="$(wc -l < "$candidates" | tr -d ' ')"
  candidate_sha="$(sha256sum "$candidates" | awk '{print $1}')"
  jq -e --arg recovery "$1" --arg sha "$candidate_sha" --argjson count "$candidate_count" '
    .version == 1 and .recovery_id == $recovery and .sha256 == $sha and .count == $count
  ' "$metadata" >/dev/null 2>&1 || return 1
  jq -e --arg candidate_sha "$candidate_sha" --arg qualified_sha "$host_sha" \
    --argjson candidate_count "$candidate_count" --argjson qualified_count "$host_count" '
    .version == 1 and .candidateSha256 == $candidate_sha and .candidateCount == $candidate_count
    and .qualifiedSha256 == $qualified_sha and .qualifiedCount == $qualified_count
    and .qualifiedCount > 0 and .qualifiedCount <= 5000
    and .candidateCount >= .qualifiedCount
    and (.blockedCount | type == "number")
    and .blockedCount == (.candidateCount - .qualifiedCount)
  ' "$receipt" >/dev/null 2>&1
}

apply_public_cutover() {
  token_file=/etc/hosting-control/cloudflare-tunnel-api.token
  [ -f "$token_file" ] && [ ! -L "$token_file" ] || return 1
  [ "$(stat -c '%u' "$token_file" 2>/dev/null || true)" = 0 ] || return 1
  [ "$(stat -c '%a' "$token_file" 2>/dev/null || true)" = 600 ] || return 1
  CLOUDFLARE_TUNNEL_API_TOKEN="$(cat "$token_file")"
  [ -n "$CLOUDFLARE_TUNNEL_API_TOKEN" ] || return 1
  export CLOUDFLARE_TUNNEL_API_TOKEN
  "$project_dir/scripts/tunnel-cutover.sh" --preview \
    --hosts-file "$AUTO_FAILOVER_HOSTS_FILE" >/dev/null \
    && "$project_dir/scripts/tunnel-cutover.sh" --apply \
      --hosts-file "$AUTO_FAILOVER_HOSTS_FILE" \
      --confirm SWITCH-TUNNEL-INGRESS >/dev/null
  result=$?
  unset CLOUDFLARE_TUNNEL_API_TOKEN
  return "$result"
}

start_promoted_replication() {
  if command -v systemctl >/dev/null 2>&1 \
    && [ -f /etc/systemd/system/hosting-database-replication.timer ]; then
    systemctl enable --now hosting-database-replication.timer >/dev/null 2>&1 \
      && systemctl start hosting-database-replication.service >/dev/null 2>&1 \
      && systemctl restart hosting-database-replication.timer >/dev/null 2>&1 \
      || printf 'Warning: public cutover succeeded, but the initial database replication snapshot failed.\n' >&2
  fi
}

write_promoted_state() {
  promoted_recovery="$1"
  promoted_failures="${2:-0}"
  promoted_unreachable_since="${3:-}"
  promoted_fencing_mode="$(jq -r '.fencing_mode // empty' /etc/hosting-control/promotion-state.json)"
  if [ "$promoted_fencing_mode" = PRIMARY-UNREACHABLE-RISK-ACCEPTED ]; then
    write_state promoted-unreachable "$promoted_failures" "$promoted_recovery" "$promoted_unreachable_since"
  else
    write_state promoted "$promoted_failures" "$promoted_recovery"
  fi
}

case "${AUTO_FAILOVER_ENABLED:-false}" in
  true) ;;
  false) write_state disabled 0; exit 0 ;;
  *) exit 1 ;;
esac
case "${AUTO_FAILOVER_MODE:-monitor}" in monitor|activate) ;; *) exit 1 ;; esac
case "${AUTO_FAILOVER_FENCE_POLICY:-receipt}" in receipt|unreachable) ;; *) exit 1 ;; esac
case "${AUTO_FAILOVER_FAILURES:-6}" in ''|*[!0-9]*) exit 1 ;; esac
[ "$AUTO_FAILOVER_FAILURES" -ge 3 ] && [ "$AUTO_FAILOVER_FAILURES" -le 30 ] || exit 1
case "${PRIMARY_HEALTH_URL:-}" in https://*) ;; *) exit 1 ;; esac
[ -f "${AUTO_FAILOVER_HOSTS_FILE:-}" ] || exit 1
write_inventory_state

exec 9>"$lock"
flock -n 9 || exit 0
role="$(jq -r '.role // empty' /etc/hosting-control/role.json 2>/dev/null || true)"
if [ "$role" = primary ]; then
  promotion=/etc/hosting-control/promotion-state.json
  cutover=/etc/hosting-control/tunnel-cutover.json
  [ -f "$promotion" ] && [ ! -L "$promotion" ] || exit 0
  recovery_id="$(jq -er '.recovery_id' "$promotion" 2>/dev/null || true)"
  [ -n "$recovery_id" ] || exit 0
  jq -e --arg recovery "$recovery_id" '
    .version == 1 and .status == "local-primary" and .recovery_id == $recovery
  ' "$promotion" >/dev/null 2>&1 || exit 0
  previous_failures="$(jq -r '.failures // 0' "$state" 2>/dev/null || printf 0)"
  previous_unreachable="$(jq -r '.unreachableSince // empty' "$state" 2>/dev/null || true)"
  case "$previous_failures" in ''|*[!0-9]*) previous_failures=0 ;; esac

  if [ -f "$cutover" ] && [ ! -L "$cutover" ] \
    && jq -e '.version == 1 and .status == "active"' "$cutover" >/dev/null 2>&1; then
    if ! jq -e '.public_ingress_cutover == true' "$promotion" >/dev/null 2>&1; then
      temporary="$promotion.tmp.$$"
      jq '.public_ingress_cutover = true' "$promotion" > "$temporary"
      chmod 644 "$temporary"
      mv "$temporary" "$promotion"
    fi
    write_promoted_state "$recovery_id" 0 "$previous_unreachable"
    exit 0
  fi

  jq -e '.public_ingress_cutover == false' "$promotion" >/dev/null 2>&1 || exit 0
  [ "${AUTO_FAILOVER_MODE:-monitor}" = activate ] || exit 0
  jq -e --arg recovery "$recovery_id" '.app_data_id == $recovery and .database_recovery_id == $recovery' \
    /etc/hosting-control/standby-recovery.json >/dev/null 2>&1 \
    || { write_state blocked-recovery "$previous_failures" "$recovery_id" "$previous_unreachable"; exit 1; }
  valid_host_qualification "$recovery_id" \
    || { write_state blocked-host-qualification "$previous_failures" "$recovery_id" "$previous_unreachable"; exit 1; }
  if [ -f "$cutover" ] && ! jq -e '.version == 1 and .status == "rolled-back"' "$cutover" >/dev/null 2>&1; then
    write_state activation-failed "$previous_failures" "$recovery_id" "$previous_unreachable"
    exit 1
  fi
  write_state activating "$previous_failures" "$recovery_id" "$previous_unreachable"
  if ! apply_public_cutover; then
    write_state activation-failed "$previous_failures" "$recovery_id" "$previous_unreachable"
    exit 1
  fi
  start_promoted_replication
  write_promoted_state "$recovery_id" 0 "$previous_unreachable"
  exit 0
fi
[ "$role" = standby ] || exit 0

healthy=0
response="$(curl -fsS --max-time 8 --connect-timeout 4 "$PRIMARY_HEALTH_URL" 2>/dev/null || true)"
printf '%s' "$response" | jq -e --arg primary "$AUTO_FAILOVER_PRIMARY_SERVER_ID" \
  '.ok == true and .role == "primary" and .serverId == $primary' >/dev/null 2>&1 && healthy=1

peer_connected=0
connection="$(docker exec hosting-sync sh -c '
  key="$(sed -n "s:.*<apikey>\\(.*\\)</apikey>.*:\\1:p" /var/syncthing/config/config.xml)"
  wget -qO- --header="X-API-Key: $key" http://127.0.0.1:8384/rest/system/connections
' 2>/dev/null || true)"
case "${AUTO_FAILOVER_PRIMARY_SYNC_DEVICE_ID:-}" in
  ???????-???????-???????-???????-???????-???????-???????-???????) ;;
  *) write_state invalid-config 0; exit 1 ;;
esac
printf '%s' "$connection" | jq -e --arg device "$AUTO_FAILOVER_PRIMARY_SYNC_DEVICE_ID" \
  '.connections[$device].connected == true' >/dev/null 2>&1 \
  && peer_connected=1

previous="$(jq -r '.failures // 0' "$state" 2>/dev/null || printf 0)"
case "$previous" in ''|*[!0-9]*) previous=0 ;; esac
if [ "$healthy" -eq 1 ] || [ "$peer_connected" -eq 1 ]; then
  failures=0
  status=healthy
  unreachable_since=""
else
  failures=$((previous + 1))
  status=primary-unreachable
  unreachable_since="$(jq -r '.unreachableSince // empty' "$state" 2>/dev/null || true)"
  case "$unreachable_since" in ????-??-??T??:??:??Z) ;; *) unreachable_since="$(date -u +%Y-%m-%dT%H:%M:%SZ)" ;; esac
fi

write_state "$status" "$failures" "" "$unreachable_since"

[ "$failures" -ge "$AUTO_FAILOVER_FAILURES" ] || exit 0
if ! "$project_dir/scripts/check-sync-ready.sh"; then
  write_state blocked-sync "$failures" "" "$unreachable_since"
  exit 1
fi
if ! recovery_id="$(jq -er '.app_data_id' /etc/hosting-control/standby-recovery.json)"; then
  write_state blocked-recovery "$failures" "" "$unreachable_since"
  exit 1
fi
case "${AUTO_FAILOVER_MAX_RECOVERY_AGE_SECONDS:-7200}" in ''|*[!0-9]*) exit 1 ;; esac
[ "${AUTO_FAILOVER_MAX_RECOVERY_AGE_SECONDS:-7200}" -ge 1800 ] \
  && [ "${AUTO_FAILOVER_MAX_RECOVERY_AGE_SECONDS:-7200}" -le 86400 ] || exit 1
recovery_iso="$(printf '%s' "$recovery_id" | sed -E 's/^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2})-([0-9]{2})-([0-9]{2})Z$/\1T\2:\3:\4Z/')"
recovery_epoch="$(date -u -d "$recovery_iso" +%s 2>/dev/null || printf 0)"
now_epoch="$(date -u +%s)"
recovery_age=$((now_epoch - recovery_epoch))
if [ "$recovery_epoch" -le 0 ] || [ "$recovery_age" -lt -300 ] \
  || [ "$recovery_age" -gt "${AUTO_FAILOVER_MAX_RECOVERY_AGE_SECONDS:-7200}" ]; then
  write_state blocked-stale-recovery "$failures" "$recovery_id" "$unreachable_since" "$recovery_age"
  exit 1
fi

if [ "${AUTO_FAILOVER_MODE:-monitor}" = monitor ]; then
  write_state threshold-reached "$failures" "$recovery_id" "$unreachable_since" "$recovery_age"
  printf 'Automatic failover threshold reached; monitor mode will not promote.\n' >&2
  exit 0
fi

if ! valid_host_qualification "$recovery_id"; then
  write_state blocked-host-qualification "$failures" "$recovery_id" "$unreachable_since" "$recovery_age"
  printf 'Automatic failover host qualification is missing, stale, or does not match the active allowlist.\n' >&2
  exit 1
fi

case "${AUTO_FAILOVER_PRIMARY_SERVER_ID:-}" in
  ''|*[!A-Za-z0-9._-]*) write_state invalid-config "$failures" "$recovery_id"; exit 1 ;;
esac
fence_confirmation=OLD-PRIMARY-FENCED
if [ "${AUTO_FAILOVER_FENCE_POLICY:-receipt}" = receipt ]; then
  case "${AUTO_FAILOVER_FENCE_MAX_AGE_SECONDS:-900}" in ''|*[!0-9]*) exit 1 ;; esac
  [ "${AUTO_FAILOVER_FENCE_MAX_AGE_SECONDS:-900}" -ge 60 ] \
    && [ "${AUTO_FAILOVER_FENCE_MAX_AGE_SECONDS:-900}" -le 3600 ] || exit 1
  if ! valid_fence_receipt "$recovery_id"; then
    write_state awaiting-fence "$failures" "$recovery_id" "$unreachable_since" "$recovery_age"
    printf 'Automatic failover is waiting for a fresh fencing receipt for %s.\n' \
      "$AUTO_FAILOVER_PRIMARY_SERVER_ID" >&2
    exit 0
  fi
else
  [ "${AUTO_FAILOVER_UNREACHABLE_RISK_ACCEPTED:-}" = I-ACCEPT-SPLIT-BRAIN-RISK ] \
    || { write_state invalid-config "$failures" "$recovery_id" "$unreachable_since"; exit 1; }
  case "${AUTO_FAILOVER_UNREACHABLE_GRACE_SECONDS:-300}" in ''|*[!0-9]*) exit 1 ;; esac
  [ "${AUTO_FAILOVER_UNREACHABLE_GRACE_SECONDS:-300}" -ge 180 ] \
    && [ "${AUTO_FAILOVER_UNREACHABLE_GRACE_SECONDS:-300}" -le 3600 ] || exit 1
  unreachable_epoch="$(date -u -d "$unreachable_since" +%s 2>/dev/null || printf 0)"
  now_epoch="$(date -u +%s)"
  if [ "$unreachable_epoch" -le 0 ] \
    || [ $((now_epoch - unreachable_epoch)) -lt "${AUTO_FAILOVER_UNREACHABLE_GRACE_SECONDS:-300}" ]; then
    write_state awaiting-unreachable-grace "$failures" "$recovery_id" "$unreachable_since" "$recovery_age"
    exit 0
  fi
  fence_confirmation=PRIMARY-UNREACHABLE-RISK-ACCEPTED
fi

write_state activating "$failures" "$recovery_id" "$unreachable_since"
if ! "$project_dir/scripts/activate-standby.sh" --preview \
  --hosts-file "$AUTO_FAILOVER_HOSTS_FILE" \
  --api-token-file /etc/hosting-control/cloudflare-tunnel-api.token \
  --recovery-id "$recovery_id" >/dev/null; then
  write_state preview-failed "$failures" "$recovery_id" "$unreachable_since"
  exit 1
fi
if ! "$project_dir/scripts/activate-standby.sh" --apply \
  --hosts-file "$AUTO_FAILOVER_HOSTS_FILE" \
  --api-token-file /etc/hosting-control/cloudflare-tunnel-api.token \
  --recovery-id "$recovery_id" \
  --confirm ACTIVATE-STANDBY --fence-confirm "$fence_confirmation" >/dev/null; then
  write_state activation-failed "$failures" "$recovery_id" "$unreachable_since"
  exit 1
fi

write_promoted_state "$recovery_id" 0 "$unreachable_since"
rm -f "${AUTO_FAILOVER_FENCE_RECEIPT:-/etc/hosting-control/primary-fence-receipt.json}"
