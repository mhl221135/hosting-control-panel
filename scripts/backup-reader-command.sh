#!/bin/sh

set -eu

root_file=${HOSTING_BACKUP_ROOT_FILE:-/etc/hosting-control/backup-reader-root}
[ -r "$root_file" ] || { printf 'Backup reader is not configured.\n' >&2; exit 1; }
IFS= read -r root < "$root_file"
case "$root" in /*) ;; *) printf 'Configured backup root is invalid.\n' >&2; exit 1 ;; esac
case "$root" in *[!A-Za-z0-9_./-]*|*..*) printf 'Configured backup root is unsafe.\n' >&2; exit 1 ;; esac
[ -d "$root" ] || { printf 'Configured backup root does not exist.\n' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { printf 'jq is required.\n' >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { printf 'sha256sum is required.\n' >&2; exit 1; }

inventory() {
  find "$root" -mindepth 3 -maxdepth 3 -type f -name manifest.json -print 2>/dev/null | while IFS= read -r manifest; do
    set_dir=${manifest%/manifest.json}
    id=${set_dir##*/}
    group_dir=${set_dir%/*}
    group=${group_dir##*/}
    case "$id" in ????-??-??T??-??-??Z) ;; *) continue ;; esac
    case "$group" in app-data|[A-Za-z0-9]*.[A-Za-z0-9]*) ;; *) continue ;; esac
    jq -e --arg id "$id" --arg group "$group" '
      .version == 2 and .id == $id and
      ((.type == "app-data" and $group == "app-data") or
       (.type == "site" and .domain == $group)) and
      (.artifacts | type == "object")
    ' "$manifest" >/dev/null 2>&1 || continue
    artifact_bytes=$(jq -er '
      [.artifacts[]?.size] |
      if length == 0 or length > 16 or
         any(.[]; (type != "number") or (. < 0) or (. > 107374182400) or (. != floor))
      then error("invalid artifact sizes") else add end
    ' "$manifest") || continue
    manifest_bytes=$(wc -c < "$manifest" | tr -d ' ')
    case "$artifact_bytes:$manifest_bytes" in *[!0-9:]*|:*) continue ;; esac
    manifest_sha=$(sha256sum "$manifest" | awk '{print $1}')
    completed_epoch=$(jq -er '.completedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601' "$manifest") || continue
    printf '%s\t%s\t%s\t%s\t%s\n' "$group" "$id" "$((artifact_bytes + manifest_bytes))" "$manifest_sha" "$completed_epoch"
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
