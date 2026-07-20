#!/bin/sh

set -eu

repository_url="https://github.com/mhl221135/hosting-control-panel.git"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this bootstrap installer as root." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "Git is required. Install Git and run this installer again." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker Engine is required. Install Docker and run this installer again." >&2
  exit 1
fi

exec 3<&0 4>&1
printf "Installation root [/media/ssdmount/websites-v2]: " >&4
IFS= read -r hosting_root <&3
hosting_root="${hosting_root:-/media/ssdmount/websites-v2}"
case "$hosting_root" in
  /*) ;;
  *) echo "Installation root must be an absolute path." >&2; exit 1 ;;
esac

sources="$hosting_root/sources"
if [ -e "$sources" ]; then
  echo "$sources already exists. Use scripts/upgrade.sh from that directory." >&2
  exit 1
fi

mkdir -p "$hosting_root"
git clone --branch main --single-branch "$repository_url" "$sources"
exec "$sources/scripts/install.sh" --configure --root "$hosting_root"
