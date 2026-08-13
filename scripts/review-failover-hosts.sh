#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: review-failover-hosts.sh --preview|--apply [options]

Options:
  --candidates PATH   Generated candidate list
  --output PATH       Active reviewed allowlist
  --recovery-id ID    Exact prepared recovery identifier (required for apply)
  --confirm TEXT      Required with apply; must be ACCEPT-FAILOVER-HOSTS

This command never changes DNS, tunnel routes, containers, or machine role.
EOF
}

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
mode=""
candidates=""
output=""
recovery_id=""
confirmation=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --preview|--apply) mode="$1" ;;
    --candidates) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; candidates="$1" ;;
    --output) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; output="$1" ;;
    --recovery-id) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; recovery_id="$1" ;;
    --confirm) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; confirmation="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { printf 'Run this command as root.\n' >&2; exit 1; }
[ -f "$env_file" ] || { printf 'Environment file does not exist: %s\n' "$env_file" >&2; exit 1; }
[ -n "$mode" ] || { usage; exit 2; }
for command in jq sha256sum awk comm sort sed cp wc; do
  command -v "$command" >/dev/null 2>&1 \
    || { printf 'Required command is missing: %s\n' "$command" >&2; exit 1; }
done

env_value() {
  awk -v key="$1" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
      if (value ~ /^".*"$/ || value ~ /^'"'"'.*'"'"'$/) value = substr(value, 2, length(value) - 2)
      print value
      exit
    }
  ' "$env_file"
}

machine_state="$(env_value HOSTING_MACHINE_STATE_DIR)"
machine_state="${machine_state:-/etc/hosting-control}"
candidates="${candidates:-$machine_state/failover-hosts.candidates.txt}"
output="${output:-$machine_state/failover-hosts.txt}"
metadata="$machine_state/failover-hosts.candidates.json"
recovery_marker="$machine_state/standby-recovery.json"
role_marker="$machine_state/role.json"

case "$candidates" in /*) ;; *) printf 'Candidates path must be absolute.\n' >&2; exit 2 ;; esac
case "$output" in /*) ;; *) printf 'Output path must be absolute.\n' >&2; exit 2 ;; esac

for file in "$candidates" "$metadata" "$recovery_marker" "$role_marker"; do
  [ -f "$file" ] && [ ! -L "$file" ] || { printf 'Required regular file is missing: %s\n' "$file" >&2; exit 1; }
done
[ ! -L "$output" ] || { printf 'Active allowlist path must not be a symlink.\n' >&2; exit 1; }
[ ! -e "$output" ] || [ -f "$output" ] \
  || { printf 'Active allowlist path must be a regular file.\n' >&2; exit 1; }
LC_ALL=C sort -c -u "$candidates" >/dev/null 2>&1 \
  || { printf 'Candidate inventory must be sorted and unique.\n' >&2; exit 1; }
jq -e '.version == 1 and .role == "standby"' "$role_marker" >/dev/null \
  || { printf 'Hostname review is restricted to the fenced standby.\n' >&2; exit 1; }

prepared_id="$(jq -er '.app_data_id' "$recovery_marker")"
prepared_source="$(jq -er '.source_release' "$recovery_marker")"
candidate_id="$(jq -er '.recovery_id' "$metadata")"
candidate_source="$(jq -er '.source_release' "$metadata")"
candidate_sha="$(sha256sum "$candidates" | awk '{print $1}')"
candidate_count="$(wc -l < "$candidates" | tr -d ' ')"
jq -e --arg id "$prepared_id" --arg source "$prepared_source" --arg sha "$candidate_sha" \
  --argjson count "$candidate_count" '
  .version == 1 and .recovery_id == $id and .source_release == $source and
  .sha256 == $sha and .count == $count and .count > 0 and .count <= 5000
' "$metadata" >/dev/null || { printf 'Candidate inventory is stale or invalid for the prepared recovery.\n' >&2; exit 1; }
[ "$candidate_id" = "$prepared_id" ] && [ "$candidate_source" = "$prepared_source" ] \
  || { printf 'Candidate inventory does not match the prepared recovery.\n' >&2; exit 1; }

empty="$(mktemp)"
trap 'rm -f "$empty"' EXIT HUP INT TERM
current="$output"
[ -f "$current" ] || current="$empty"
LC_ALL=C sort -c -u "$current" >/dev/null 2>&1 \
  || { printf 'Current allowlist must be sorted and unique.\n' >&2; exit 1; }
printf 'Prepared recovery: %s\n' "$prepared_id"
printf 'Candidates: %s  Current allowlist: %s\n' \
  "$(wc -l < "$candidates" | tr -d ' ')" "$(wc -l < "$current" | tr -d ' ')"
printf '%s\n' 'Additions:'
LC_ALL=C comm -13 "$current" "$candidates" | sed -n '1,200p'
printf '%s\n' 'Removals:'
LC_ALL=C comm -23 "$current" "$candidates" | sed -n '1,200p'

[ "$mode" = --preview ] && exit 0
[ "$confirmation" = ACCEPT-FAILOVER-HOSTS ] \
  || { printf 'Apply requires --confirm ACCEPT-FAILOVER-HOSTS.\n' >&2; exit 2; }
[ "$recovery_id" = "$prepared_id" ] \
  || { printf 'Apply requires --recovery-id %s.\n' "$prepared_id" >&2; exit 2; }

temporary="$(dirname -- "$output")/.failover-hosts.active.$$.tmp"
cp "$candidates" "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$output"
printf 'Accepted %s failover hostnames for recovery %s. Public ingress was not changed.\n' \
  "$(wc -l < "$output" | tr -d ' ')" "$prepared_id"
