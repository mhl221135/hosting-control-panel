#!/bin/sh

set -eu

repository_url="https://github.com/mhl221135/hosting-control-panel.git"
hosting_root=""
installation_role=""
server_id=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) shift; [ "$#" -gt 0 ] || { echo "--root requires a directory." >&2; exit 1; }; hosting_root="$1" ;;
    --role) shift; [ "$#" -gt 0 ] || { echo "--role requires standalone, primary, or standby." >&2; exit 1; }; installation_role="$1" ;;
    --server-id) shift; [ "$#" -gt 0 ] || { echo "--server-id requires a value." >&2; exit 1; }; server_id="$1" ;;
    *) echo "Unknown bootstrap option: $1" >&2; exit 1 ;;
  esac
  shift
done

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
if [ -z "$hosting_root" ]; then
  printf "Installation root [/media/ssdmount/websites-v2]: " >&4
  IFS= read -r hosting_root <&3
  hosting_root="${hosting_root:-/media/ssdmount/websites-v2}"
fi
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
set -- --configure --root "$hosting_root"
[ -z "$installation_role" ] || set -- "$@" --role "$installation_role"
[ -z "$server_id" ] || set -- "$@" --server-id "$server_id"
exec "$sources/scripts/install.sh" "$@"
