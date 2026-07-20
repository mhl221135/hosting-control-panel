#!/bin/sh

set -eu

database=/database/filebrowser.db

if [ ! -f "$database" ]; then
  : "${FILEBROWSER_ADMIN_USERNAME:?FILEBROWSER_ADMIN_USERNAME is required}"
  : "${FILEBROWSER_ADMIN_PASSWORD:?FILEBROWSER_ADMIN_PASSWORD is required}"

  password_hash="$(filebrowser hash "$FILEBROWSER_ADMIN_PASSWORD")"
  set -- \
    --username "$FILEBROWSER_ADMIN_USERNAME" \
    --password "$password_hash" \
    "$@"
fi

exec /init.sh "$@"
