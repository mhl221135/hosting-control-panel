#!/bin/sh

set -eu

if ! docker inspect hosting-ui >/dev/null 2>&1; then
  echo "hosting-ui is not running. Start the stack before exporting." >&2
  exit 1
fi

tty_flag=""
[ -t 0 ] && tty_flag="-t"
docker exec -i $tty_flag hosting-ui node /app/cli/sites-transfer.js export
