#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: qualify-failover-hosts.sh --preview|--apply [options]

Options:
  --candidates PATH   Prepared candidate hostname list
  --output PATH       Active automatic-failover allowlist
  --api-token-file PATH
                      Root-owned Cloudflare tunnel management token
  --recovery-id ID    Exact prepared recovery identifier (required for apply)
  --confirm TEXT      Required for apply; ACCEPT-QUALIFIED-FAILOVER-HOSTS
  --skip-if-current   Skip provider calls when a matching receipt is under 24h old

The Cloudflare/tunnel operation is preview-only. Apply writes only hostnames
reported ready by that preview into the local automatic-failover allowlist.
EOF
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
mode=""
candidates=/etc/hosting-control/failover-hosts.candidates.txt
output=/etc/hosting-control/failover-hosts.auto.txt
api_token_file=/etc/hosting-control/cloudflare-tunnel-api.token
recovery_id=""
confirmation=""
skip_if_current=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --preview|--apply) mode="$1" ;;
    --candidates) shift; candidates="${1:-}" ;;
    --output) shift; output="${1:-}" ;;
    --api-token-file) shift; api_token_file="${1:-}" ;;
    --recovery-id) shift; recovery_id="${1:-}" ;;
    --confirm) shift; confirmation="${1:-}" ;;
    --skip-if-current) skip_if_current=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { printf 'Run as root.\n' >&2; exit 1; }
[ -n "$mode" ] || { usage; exit 2; }
for value in "$candidates" "$output" "$api_token_file"; do
  case "$value" in /*) ;; *) printf 'All paths must be absolute.\n' >&2; exit 2 ;; esac
done
for command in jq sha256sum sort cmp mktemp awk wc; do
  command -v "$command" >/dev/null 2>&1 || { printf 'Required command is missing: %s\n' "$command" >&2; exit 1; }
done
[ -f "$candidates" ] && [ ! -L "$candidates" ] || { printf 'Candidate inventory is unavailable.\n' >&2; exit 1; }
LC_ALL=C sort -c -u "$candidates" >/dev/null 2>&1 || { printf 'Candidates must be sorted and unique.\n' >&2; exit 1; }

machine_state="$(dirname -- "$candidates")"
metadata="$machine_state/failover-hosts.candidates.json"
recovery_marker="$machine_state/standby-recovery.json"
role_marker="$machine_state/role.json"
for file in "$metadata" "$recovery_marker" "$role_marker"; do
  [ -f "$file" ] && [ ! -L "$file" ] || { printf 'Required state file is unavailable: %s\n' "$file" >&2; exit 1; }
done
jq -e '.version == 1 and .role == "standby"' "$role_marker" >/dev/null \
  || { printf 'Qualification requires the fenced standby role.\n' >&2; exit 1; }
prepared_id="$(jq -er '.app_data_id' "$recovery_marker")"
candidate_count="$(wc -l < "$candidates" | tr -d ' ')"
candidate_sha="$(sha256sum "$candidates" | awk '{print $1}')"
jq -e --arg id "$prepared_id" --arg sha "$candidate_sha" --argjson count "$candidate_count" '
  .version == 1 and .recovery_id == $id and .sha256 == $sha and .count == $count and .count > 0
' "$metadata" >/dev/null || { printf 'Candidate inventory is stale or invalid.\n' >&2; exit 1; }

receipt="$machine_state/failover-hosts.qualification.json"
if [ "$mode" = --apply ] && [ "$skip_if_current" -eq 1 ] \
  && [ -f "$output" ] && [ ! -L "$output" ] && [ -f "$receipt" ] && [ ! -L "$receipt" ] \
  && [ "$(stat -c '%u' "$receipt" 2>/dev/null || true)" = 0 ] \
  && [ "$(stat -c '%a' "$receipt" 2>/dev/null || true)" = 600 ] \
  && LC_ALL=C sort -c -u "$output" >/dev/null 2>&1; then
  output_count="$(wc -l < "$output" | tr -d ' ')"
  output_sha="$(sha256sum "$output" | awk '{print $1}')"
  qualified_at="$(jq -r '.qualifiedAt // empty' "$receipt" 2>/dev/null || true)"
  qualified_epoch="$(date -u -d "$qualified_at" +%s 2>/dev/null || printf 0)"
  now_epoch="$(date -u +%s)"
  if [ "$qualified_epoch" -gt 0 ] && [ $((now_epoch - qualified_epoch)) -ge 0 ] \
    && [ $((now_epoch - qualified_epoch)) -lt 86400 ] \
    && jq -e --arg candidate_sha "$candidate_sha" --arg output_sha "$output_sha" \
      --argjson candidate_count "$candidate_count" --argjson output_count "$output_count" '
        .version == 1 and .candidateSha256 == $candidate_sha and .candidateCount == $candidate_count
        and .qualifiedSha256 == $output_sha and .qualifiedCount == $output_count
      ' "$receipt" >/dev/null 2>&1; then
    printf 'Failover hostname qualification is current; provider preview skipped.\n'
    exit 0
  fi
fi

[ -f "$api_token_file" ] && [ ! -L "$api_token_file" ] || { printf 'API token file is unavailable.\n' >&2; exit 1; }
[ "$(stat -c '%u' "$api_token_file" 2>/dev/null || true)" = 0 ] \
  && [ "$(stat -c '%a' "$api_token_file" 2>/dev/null || true)" = 600 ] \
  || { printf 'API token file must be root-owned mode 600.\n' >&2; exit 1; }

preview="$(mktemp)"
ready="$(mktemp)"
observed="$(mktemp)"
temporary=""
receipt_tmp=""
cleanup() {
  rm -f "$preview" "$ready" "$observed"
  [ -z "$temporary" ] || rm -f "$temporary"
  [ -z "$receipt_tmp" ] || rm -f "$receipt_tmp"
}
trap cleanup EXIT HUP INT TERM
CLOUDFLARE_TUNNEL_API_TOKEN="$(cat "$api_token_file")"
export CLOUDFLARE_TUNNEL_API_TOKEN
preview_status=0
"$project_dir/scripts/tunnel-cutover.sh" --preview --hosts-file "$candidates" > "$preview" || preview_status=$?
jq -e '.hosts and .records and (.hosts | type == "array") and (.records | type == "array")' "$preview" >/dev/null \
  || { printf 'Cloudflare qualification did not return a valid preview.\n' >&2; exit 1; }
jq -r '.records[].hostname' "$preview" | LC_ALL=C sort -u > "$observed"
cmp -s "$candidates" "$observed" || { printf 'Cloudflare preview did not cover the exact candidate inventory.\n' >&2; exit 1; }
jq -r '.records[] | select(.status == "ready") | .hostname' "$preview" | LC_ALL=C sort -u > "$ready"
ready_count="$(wc -l < "$ready" | tr -d ' ')"
blocked_count=$((candidate_count - ready_count))
[ "$ready_count" -gt 0 ] || { printf 'Cloudflare preview qualified no hostnames.\n' >&2; exit 1; }
printf 'Prepared recovery: %s\nCandidates: %s  Qualified: %s  Blocked: %s\n' \
  "$prepared_id" "$candidate_count" "$ready_count" "$blocked_count"
if [ "$blocked_count" -gt 0 ]; then
  printf '%s\n' 'Blocked hostnames:'
  jq -r '.records[] | select(.status != "ready") | "\(.hostname): \(.reason // "not ready")"' "$preview" | sed -n '1,200p'
fi
[ "$preview_status" -eq 0 ] || [ "$blocked_count" -gt 0 ] \
  || { printf 'Cloudflare preview failed.\n' >&2; exit 1; }

[ "$mode" = --preview ] && exit 0
[ "$confirmation" = ACCEPT-QUALIFIED-FAILOVER-HOSTS ] \
  || { printf 'Apply requires --confirm ACCEPT-QUALIFIED-FAILOVER-HOSTS.\n' >&2; exit 2; }
[ "$recovery_id" = "$prepared_id" ] \
  || { printf 'Apply requires --recovery-id %s.\n' "$prepared_id" >&2; exit 2; }
[ ! -L "$output" ] || { printf 'Output must not be a symlink.\n' >&2; exit 1; }
temporary="$(dirname -- "$output")/.failover-hosts.qualified.$$.tmp"
cp "$ready" "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$output"
temporary=""
receipt_tmp="$receipt.tmp.$$"
jq -n --arg qualified_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg recovery_id "$prepared_id" \
  --arg candidate_sha "$candidate_sha" --arg qualified_sha "$(sha256sum "$output" | awk '{print $1}')" \
  --argjson candidate_count "$candidate_count" --argjson qualified_count "$ready_count" \
  --argjson blocked_count "$blocked_count" \
  '{version:1,qualifiedAt:$qualified_at,recoveryId:$recovery_id,candidateSha256:$candidate_sha,
    qualifiedSha256:$qualified_sha,candidateCount:$candidate_count,qualifiedCount:$qualified_count,
    blockedCount:$blocked_count}' > "$receipt_tmp"
chmod 600 "$receipt_tmp"
mv "$receipt_tmp" "$receipt"
receipt_tmp=""
printf 'Accepted %s Cloudflare-qualified hostnames for automatic failover. DNS and tunnel routes were not changed.\n' "$ready_count"
