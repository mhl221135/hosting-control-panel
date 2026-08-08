#!/bin/sh

set -eu

root_file=${HOSTING_BACKUP_ROOT_FILE:-/etc/hosting-control/backup-reader-root}
[ -r "$root_file" ] || { printf 'Backup reader is not configured.\n' >&2; exit 1; }
IFS= read -r root < "$root_file"
case "$root" in /*) ;; *) printf 'Configured backup root is invalid.\n' >&2; exit 1 ;; esac
case "$root" in *[!A-Za-z0-9_./-]*|*..*) printf 'Configured backup root is unsafe.\n' >&2; exit 1 ;; esac
[ -d "$root" ] || { printf 'Configured backup root does not exist.\n' >&2; exit 1; }

inventory() {
  find "$root" -mindepth 3 -maxdepth 3 -type f -name manifest.json -print 2>/dev/null | while IFS= read -r manifest; do
    set_dir=${manifest%/manifest.json}
    id=${set_dir##*/}
    group_dir=${set_dir%/*}
    group=${group_dir##*/}
    case "$id" in ????-??-??T??-??-??Z) ;; *) continue ;; esac
    case "$group" in app-data|[A-Za-z0-9]*.[A-Za-z0-9]*) ;; *) continue ;; esac
    blocks=$(du -sk "$set_dir")
    blocks=${blocks%%[[:space:]]*}
    case "$blocks" in ""|*[!0-9]*) exit 4 ;; esac
    printf '%s\t%s\t%s\n' "$group" "$id" "$((blocks * 1024))"
  done
}

command=${SSH_ORIGINAL_COMMAND:-}
if [ "$command" = hosting-backup-inventory ]; then
  inventory
  exit 0
fi

case "$command" in
  "rsync --server --sender "*) ;;
  *) printf 'Command is not allowed.\n' >&2; exit 126 ;;
esac
case "$command" in
  *[!A-Za-z0-9_./\ -]*)
    printf 'Unsafe rsync command.\n' >&2
    exit 126
    ;;
esac
requested=${command##* }
case "$requested" in
  "$root"/*) ;;
  *) printf 'Rsync path is outside the backup root.\n' >&2; exit 126 ;;
esac
case "$requested" in *..*) printf 'Rsync path is unsafe.\n' >&2; exit 126 ;; esac

exec sh -c "$command"
