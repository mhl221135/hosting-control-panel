#!/bin/sh

set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this import as root so it can stage database dumps." >&2
  exit 1
fi
if [ ! -f "$env_file" ]; then
  echo "$env_file is missing." >&2
  exit 1
fi

hosting_root="$(awk '
  index($0, "HOSTING_ROOT=") == 1 {
    value = substr($0, 14)
    if (value ~ /^".*"$/ || value ~ /^'\''.*'\''$/) value = substr(value, 2, length(value) - 2)
    print value
    exit
  }
' "$env_file")"
hosting_root="${hosting_root:-/media/ssdmount/websites-v2}"

printf "Directory containing manifest.json, import-sites.json, or database .sql.gz dumps: "
IFS= read -r source_directory
if [ ! -d "$source_directory" ]; then
  echo "Import source directory does not exist." >&2
  exit 1
fi
if ! docker inspect hosting-ui >/dev/null 2>&1; then
  echo "hosting-ui is not running. Start the stack before importing." >&2
  exit 1
fi

stamp="$(date -u +%Y-%m-%d_%H-%M-%S)"
stage_name="import-$stamp"
stage="$hosting_root/imports/$stage_name"
mkdir -p "$stage"
cp -a "$source_directory/." "$stage/"
chmod -R go-rwx "$stage"

tty_flag=""
[ -t 0 ] && tty_flag="-t"
docker exec -i $tty_flag hosting-ui node /app/cli/sites-transfer.js import "/srv/imports/$stage_name"

echo "Staged import files remain at $stage for review or manual removal."
