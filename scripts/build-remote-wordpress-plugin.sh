#!/bin/sh

set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
source_dir="$root/wordpress-plugin"
dist="$source_dir/dist"
version="$(sed -n 's/^ \* Version: //p' "$source_dir/hostpilot-remote/hostpilot-remote.php" | head -1)"
stage="$(mktemp -d "${TMPDIR:-/tmp}/hostpilot-plugin.XXXXXX")"
trap 'rm -rf "$stage"' EXIT HUP INT TERM
test -n "$version"
command -v zip >/dev/null 2>&1 || { echo "zip is required" >&2; exit 1; }
rm -rf "$dist"
mkdir -p "$dist"
cp -R "$source_dir/hostpilot-remote" "$stage/hostpilot-remote"
cp "$source_dir/mu-loader/hostpilot-remote-loader.php" "$stage/hostpilot-remote-loader.php"
find "$stage" -exec touch -t 202001010000 {} +
(cd "$stage" && find hostpilot-remote -type f | LC_ALL=C sort | zip -X -q "$dist/hostpilot-remote-$version.zip" -@)
(cd "$stage" && printf '%s\n' hostpilot-remote-loader.php | zip -X -q "$dist/hostpilot-remote-mu-loader-$version.zip" -@)
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$dist" && sha256sum *.zip > SHA256SUMS)
else
  (cd "$dist" && shasum -a 256 *.zip > SHA256SUMS)
fi
printf 'Built HostPilot Remote Billing %s in %s\n' "$version" "$dist"
