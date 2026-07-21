#!/bin/sh

set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

failed=false
audit_tmp="$(mktemp -d "${TMPDIR:-/tmp}/hosting-security-audit.XXXXXX")"
trap 'rm -rf "$audit_tmp"' EXIT HUP INT TERM

prohibited_paths='(^|/)(\.env|.*\.log|logs?|letsencrypt|certificates?|.*\.pem|.*\.key|.*\.crt|.*\.p12|.*\.sqlite3?|.*\.db|keys\.json)$|^docs/images/'
tracked_prohibited="$(git ls-files | grep -E -i "$prohibited_paths" || true)"
if [ -n "$tracked_prohibited" ]; then
  printf 'Refusing tracked runtime or screenshot artifacts:\n%s\n' "$tracked_prohibited" >&2
  failed=true
fi

historical_prohibited="$(git rev-list --objects HEAD | sed 's/^[^ ]* //' | grep -E -i "$prohibited_paths" || true)"
if [ -n "$historical_prohibited" ]; then
  printf 'Runtime or screenshot artifacts remain in Git history:\n%s\n' "$historical_prohibited" >&2
  failed=true
fi

if git grep -I -n -E 'cfat_[A-Za-z0-9_-]{20,}|cfut_[A-Za-z0-9_-]{20,}|-----BEGIN ([A-Z ]+)?PRIVATE KEY-----' -- . >"$audit_tmp/patterns" 2>/dev/null; then
  printf 'Potential token or private key material found in tracked files:\n' >&2
  cut -d: -f1-2 "$audit_tmp/patterns" >&2
  failed=true
fi

deny_patterns="${HOSTING_SECURITY_DENY_PATTERNS:-$project_dir/.security-deny-patterns}"
if [ -s "$deny_patterns" ]; then
  if git grep -I -n -i -f "$deny_patterns" -- . >"$audit_tmp/identifiers" 2>/dev/null; then
    printf 'A locally denied production identifier was found in tracked text:\n' >&2
    cut -d: -f1-2 "$audit_tmp/identifiers" >&2
    failed=true
  fi
  if git log -p --format= HEAD | grep -i -f "$deny_patterns" >"$audit_tmp/history-identifiers" 2>/dev/null; then
    printf 'A locally denied production identifier remains in Git history.\n' >&2
    failed=true
  fi
fi

if command -v gitleaks >/dev/null 2>&1; then
  if ! gitleaks git . --redact=100 --no-banner; then
    failed=true
  fi
else
  printf 'gitleaks is not installed; history secret scanning was skipped.\n' >&2
  printf 'Install it before a release: https://github.com/gitleaks/gitleaks\n' >&2
  failed=true
fi

if [ "$failed" = true ]; then
  printf 'Security audit failed.\n' >&2
  exit 1
fi

printf 'Security audit passed.\n'
