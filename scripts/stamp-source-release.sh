#!/bin/sh

set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
release="${HOSTING_SOURCE_RELEASE:-}"
if [ -z "$release" ]; then
  release="$(git -C "$project_dir" rev-parse --verify HEAD 2>/dev/null || true)"
fi
case "$release" in
  ''|*[!A-Za-z0-9._+-]*)
    printf 'A valid source release could not be determined.\n' >&2
    exit 1
    ;;
esac
[ "${#release}" -ge 7 ] && [ "${#release}" -le 128 ] \
  || { printf 'Source release length is invalid.\n' >&2; exit 1; }

temporary="$project_dir/.source-release.tmp.$$"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
umask 022
printf '%s\n' "$release" > "$temporary"
mv "$temporary" "$project_dir/.source-release"
trap - EXIT HUP INT TERM
printf 'Recorded source release %s.\n' "$release"
