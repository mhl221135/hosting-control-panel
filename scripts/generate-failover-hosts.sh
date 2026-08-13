#!/bin/sh

set -eu

usage() {
  printf 'Usage: generate-failover-hosts.sh --sites-map PATH --output PATH\n' >&2
}

sites_map=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --sites-map) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; sites_map="$1" ;;
    --output) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; output="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
  shift
done

case "$sites_map" in /*) ;; *) printf 'Sites map path must be absolute.\n' >&2; exit 2 ;; esac
case "$output" in /*) ;; *) printf 'Output path must be absolute.\n' >&2; exit 2 ;; esac
[ -f "$sites_map" ] && [ ! -L "$sites_map" ] \
  || { printf 'Sites map must be a regular, non-symlink file.\n' >&2; exit 1; }
[ ! -L "$output" ] || { printf 'Output path must not be a symlink.\n' >&2; exit 1; }

directory="$(dirname -- "$output")"
mkdir -p "$directory"
temporary="$directory/.failover-hosts.$$.tmp"
raw="$directory/.failover-hosts.$$.raw"
trap 'rm -f "$temporary" "$raw"' EXIT HUP INT TERM

awk '
  /^map[[:space:]]+\$host[[:space:]]+\$site_root[[:space:]]*\{/ { inside=1; found=1; next }
  inside && /^[[:space:]]*}/ { inside=0; next }
  inside {
    line=$0
    sub(/^[[:space:]]+/, "", line)
    if (line == "" || line ~ /^#/) next
    if (line !~ /;[[:space:]]*$/) exit 2
    sub(/;[[:space:]]*$/, "", line)
    count=split(line, field, /[[:space:]]+/)
    if (count != 2) exit 2
    host=tolower(field[1])
    root=field[2]
    if (host == "default") next
    if (root !~ /^\/var\/www\/[A-Za-z0-9._-]+$/) exit 3
    if (host !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/) exit 4
    print host
    emitted++
  }
  END {
    if (!found || inside || emitted == 0) exit 5
  }
' "$sites_map" > "$raw" \
  || { printf 'Could not derive a safe failover hostname inventory from sites.map.\n' >&2; exit 1; }
LC_ALL=C sort -u "$raw" > "$temporary"

count="$(wc -l < "$temporary" | tr -d ' ')"
case "$count" in ''|*[!0-9]*) printf 'Generated hostname count is invalid.\n' >&2; exit 1 ;; esac
[ "$count" -gt 0 ] && [ "$count" -le 5000 ] \
  || { printf 'Generated hostname count is outside 1-5000.\n' >&2; exit 1; }
chmod 600 "$temporary"
mv "$temporary" "$output"
trap - EXIT HUP INT TERM
rm -f "$raw"
printf 'Generated %s failover hostname candidates.\n' "$count"
