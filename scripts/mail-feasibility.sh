#!/usr/bin/env bash

set -u

mode="all"
region="${AWS_REGION:-us-east-1}"
expected_wan_ip="${MAIL_EXPECTED_WAN_IP:-}"
mail_hostname="${MAIL_HOSTNAME:-}"
data_path="${MAIL_DATA_PATH:-/media/ssdmount}"
backup_path="${MAIL_BACKUP_PATH:-/media/seagate}"
min_free_gib="${MAIL_MIN_FREE_GIB:-20}"
passes=0
warnings=0
failures=0

usage() {
  cat <<'EOF'
Usage: mail-feasibility.sh [options]

Read-only preflight for the future isolated mail platform.

Options:
  --mode all|host|aws       Run every check, target-host checks, or AWS checks
  --region REGION           Amazon SES region (default: us-east-1)
  --expected-wan-ip IPV4    Require the target host to report this public IPv4
  --mail-hostname HOSTNAME  Require public IPv4 PTR to match this mail hostname
  --data-path PATH          Planned mailbox storage filesystem
  --backup-path PATH        Planned mail backup filesystem
  --min-free-gib NUMBER     Required free space on each filesystem (default: 20)
  --help                    Show this help

Run --mode host on the target server. Run --mode aws on a trusted administrator
machine with short-lived AWS credentials; do not copy AWS credentials to the
mail host just to run this preflight.
EOF
}

valid_ipv4() {
  local value="$1" octet
  local -a octets
  IFS='.' read -r -a octets <<<"$value"
  [ "${#octets[@]}" -eq 4 ] || return 1
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] && [ "$((10#$octet))" -le 255 ] || return 1
  done
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) mode="${2:-}"; shift 2 ;;
    --region) region="${2:-}"; shift 2 ;;
    --expected-wan-ip) expected_wan_ip="${2:-}"; shift 2 ;;
    --mail-hostname) mail_hostname="${2:-}"; shift 2 ;;
    --data-path) data_path="${2:-}"; shift 2 ;;
    --backup-path) backup_path="${2:-}"; shift 2 ;;
    --min-free-gib) min_free_gib="${2:-}"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 64 ;;
  esac
done

case "$mode" in all|host|aws) ;; *) printf 'Invalid mode: %s\n' "$mode" >&2; exit 64 ;; esac
[[ "$region" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]] || { printf 'Invalid AWS region.\n' >&2; exit 64; }
[[ "$min_free_gib" =~ ^[0-9]+$ ]] && [ "$min_free_gib" -ge 1 ] || { printf 'Minimum free GiB must be a positive integer.\n' >&2; exit 64; }
if [ -n "$expected_wan_ip" ] && ! valid_ipv4 "$expected_wan_ip"; then
  printf 'Expected WAN address must be IPv4.\n' >&2
  exit 64
fi
if [ -n "$mail_hostname" ] && ! [[ "$mail_hostname" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then
  printf 'Mail hostname is invalid.\n' >&2
  exit 64
fi

record() {
  local state="$1" name="$2" detail="$3"
  printf '%-5s %-30s %s\n' "$state" "$name" "$detail"
  case "$state" in
    PASS) passes=$((passes + 1)) ;;
    WARN) warnings=$((warnings + 1)) ;;
    FAIL) failures=$((failures + 1)) ;;
  esac
}

free_gib() {
  local target="$1"
  df -Pk "$target" 2>/dev/null | awk 'NR == 2 { printf "%d", $4 / 1048576 }'
}

port_listener() {
  local port="$1"
  ss -H -ltn 2>/dev/null | awk -v port="$port" '
    {
      address=$4
      sub(/^.*:/, "", address)
      if (address == port) found=1
    }
    END { exit found ? 0 : 1 }
  '
}

tcp_open() {
  local host="$1" port="$2"
  timeout 8 bash -c "exec 3<>/dev/tcp/${host}/${port}" >/dev/null 2>&1
}

host_checks() {
  printf '\nHost and network gates\n'
  printf '%s\n' '----------------------'
  case "$(uname -m)" in
    aarch64|arm64|x86_64|amd64) record PASS "CPU architecture" "$(uname -m) is supported" ;;
    *) record WARN "CPU architecture" "$(uname -m) needs image qualification" ;;
  esac

  for command in curl timeout ss getent df; do
    if command -v "$command" >/dev/null 2>&1; then
      record PASS "Command: $command" "available"
    else
      record FAIL "Command: $command" "required by preflight or operation"
    fi
  done

  local target available
  for target in "$data_path" "$backup_path"; do
    if [ ! -d "$target" ]; then
      record FAIL "Storage: $target" "directory does not exist"
      continue
    fi
    available="$(free_gib "$target")"
    if [ -n "$available" ] && [ "$available" -ge "$min_free_gib" ]; then
      record PASS "Storage: $target" "${available} GiB free"
    else
      record FAIL "Storage: $target" "${available:-0} GiB free; require ${min_free_gib} GiB"
    fi
  done

  local wan=""
  wan="$(curl -4fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  if valid_ipv4 "$wan"; then
    if [ -n "$expected_wan_ip" ]; then
      if [ "$wan" = "$expected_wan_ip" ]; then
        record PASS "WAN IPv4" "matches the operator-pinned address"
        record WARN "Static WAN contract" "confirm the ISP allocation cannot change unexpectedly"
      else
        record FAIL "WAN IPv4" "does not match the operator-pinned address"
      fi
    else
      record WARN "WAN IPv4" "detected, but static-address ownership is not pinned"
    fi
  else
    record FAIL "WAN IPv4" "could not determine a public IPv4 address"
  fi

  if [ -n "$wan" ]; then
    local ptr=""
    ptr="$(getent hosts "$wan" 2>/dev/null | awk 'NR == 1 { print $2 }' | sed 's/\.$//' || true)"
    if [ -n "$mail_hostname" ]; then
      if [ "${ptr,,}" = "${mail_hostname,,}" ]; then
        record PASS "PTR / reverse DNS" "matches the configured mail hostname"
        if getent ahostsv4 "$mail_hostname" 2>/dev/null | awk -v wan="$wan" '$1 == wan { found=1 } END { exit found ? 0 : 1 }'; then
          record PASS "Forward-confirmed PTR" "mail hostname resolves back to the WAN IPv4"
        else
          record FAIL "Forward-confirmed PTR" "mail hostname does not resolve back to the WAN IPv4"
        fi
      else
        record FAIL "PTR / reverse DNS" "does not match the configured mail hostname"
      fi
    elif [ -n "$ptr" ]; then
      record WARN "PTR / reverse DNS" "exists, but the intended mail hostname is not pinned"
    else
      record FAIL "PTR / reverse DNS" "no reverse record returned"
    fi
  fi

  local port
  for port in 25 587 993; do
    if port_listener "$port"; then
      record FAIL "Local TCP $port" "already occupied; identify the listener before deployment"
    else
      record PASS "Local TCP $port" "available for the future mail stack"
    fi
  done

  local ses_endpoint="email-smtp.${region}.amazonaws.com"
  if tcp_open "$ses_endpoint" 587; then
    record PASS "SES relay TCP 587" "outbound connection succeeds"
  else
    record FAIL "SES relay TCP 587" "outbound connection failed"
  fi
  if tcp_open "$ses_endpoint" 25; then
    record PASS "Outbound TCP 25" "connection succeeds"
  else
    record WARN "Outbound TCP 25" "blocked or unavailable; SES submission can still use 587"
  fi

  if command -v timedatectl >/dev/null 2>&1 && [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ]; then
    record PASS "Clock synchronization" "NTP synchronized"
  else
    record WARN "Clock synchronization" "could not confirm NTP synchronization"
  fi

  record WARN "Inbound reachability" "TCP 25/587/993 require a test from an independent Internet host after listeners exist"
  record WARN "Abuse process" "operator must document complaint, compromised-account, and queue response"
}

aws_checks() {
  printf '\nAWS SES gates\n'
  printf '%s\n' '-------------'
  if ! command -v aws >/dev/null 2>&1; then
    record WARN "AWS CLI" "run --mode aws on a trusted administrator machine"
    return
  fi
  if ! aws sts get-caller-identity --output text >/dev/null 2>&1; then
    record WARN "AWS authentication" "short-lived AWS session is absent or expired"
    return
  fi
  record PASS "AWS authentication" "active short-lived identity"

  local account
  if ! account="$(aws sesv2 get-account --region "$region" \
    --query '[ProductionAccessEnabled,SendingEnabled,SendQuota.Max24HourSend,SendQuota.MaxSendRate]' \
    --output text 2>/dev/null)"; then
    record FAIL "SES account access" "get-account failed in ${region}"
    return
  fi
  local production sending daily rate
  read -r production sending daily rate <<<"$account"
  if [ "$production" = "True" ]; then
    record PASS "SES production access" "enabled in ${region}"
  else
    record FAIL "SES production access" "sandbox/production access gate is not satisfied"
  fi
  if [ "$sending" = "True" ]; then
    record PASS "SES sending" "enabled"
  else
    record FAIL "SES sending" "account sending is disabled"
  fi
  record PASS "SES quota visibility" "daily=${daily:-unknown}, rate=${rate:-unknown}/s"

  local identities
  identities="$(aws sesv2 list-email-identities --region "$region" --query 'length(EmailIdentities)' --output text 2>/dev/null || true)"
  if [[ "$identities" =~ ^[0-9]+$ ]]; then
    record PASS "SES identity inventory" "${identities} identities readable"
  else
    record WARN "SES identity inventory" "identity inventory could not be read"
  fi
  record WARN "SES event transport" "SNS/SQS bounce and complaint pipeline is not implemented"
  record WARN "SES runtime identity" "least-privilege mail-control credentials are not designed yet"
}

printf 'Mail platform feasibility preflight\n'
printf 'Mode: %s | SES region: %s\n' "$mode" "$region"
[ "$mode" = "aws" ] || host_checks
[ "$mode" = "host" ] || aws_checks

printf '\nSummary\n'
printf '%s\n' '-------'
printf 'PASS=%d WARN=%d FAIL=%d\n' "$passes" "$warnings" "$failures"
if [ "$failures" -gt 0 ]; then
  printf 'Verdict: NO-GO until every FAIL is resolved and independently verified.\n'
  exit 2
fi
if [ "$warnings" -gt 0 ]; then
  printf 'Verdict: CONDITIONAL; do not migrate production mail until WARN gates are verified.\n'
  exit 0
fi
printf 'Verdict: GO for an isolated non-production pilot only.\n'
