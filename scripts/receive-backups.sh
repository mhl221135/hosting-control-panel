#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: receive-backups.sh --source PATH|USER@HOST:/PATH --destination PATH [options]

Options:
  --retention N     Verified sets retained per website/app-data group (default: 3)
  --reserve-gb N    Free space that must remain after each transfer (default: 20)
  --ssh-option OPT  Additional ssh/rsync ssh option; may be repeated
  --dry-run         Inventory and capacity checks only
EOF
}

source_spec=""
destination=""
retention=3
reserve_gb=20
dry_run=0
ssh_options=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; source_spec="$1" ;;
    --destination) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; destination="$1" ;;
    --retention) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; retention="$1" ;;
    --reserve-gb) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; reserve_gb="$1" ;;
    --ssh-option) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; ssh_options="$ssh_options $1" ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
  shift
done

[ -n "$source_spec" ] && [ -n "$destination" ] || { usage; exit 2; }
case "$retention" in ''|*[!0-9]*) printf 'Retention must be an integer.\n' >&2; exit 2 ;; esac
case "$reserve_gb" in ''|*[!0-9]*) printf 'Reserve must be an integer number of GiB.\n' >&2; exit 2 ;; esac
[ "$retention" -ge 1 ] && [ "$retention" -le 30 ] || { printf 'Retention must be from 1 to 30.\n' >&2; exit 2; }
[ "$reserve_gb" -le 100000 ] || { printf 'Reserve is too large.\n' >&2; exit 2; }
case "$destination" in /*) ;; *) printf 'Destination must be an absolute path.\n' >&2; exit 2 ;; esac

for command in jq sha256sum gzip tar awk sort find du df mktemp; do
  command -v "$command" >/dev/null 2>&1 || { printf 'Required command is missing: %s\n' "$command" >&2; exit 1; }
done

remote=""
source_root="$source_spec"
case "$source_spec" in
  *:/*)
    remote=${source_spec%%:*}
    source_root=${source_spec#*:}
    case "$remote" in ''|*[!A-Za-z0-9_.@-]*) printf 'Remote SSH target is invalid.\n' >&2; exit 2 ;; esac
    command -v ssh >/dev/null 2>&1 || { printf 'ssh is required for a remote source.\n' >&2; exit 1; }
    command -v rsync >/dev/null 2>&1 || { printf 'rsync is required for a remote source.\n' >&2; exit 1; }
    ;;
esac
case "$source_root" in
  /*) ;;
  *) printf 'Source path must be absolute.\n' >&2; exit 2 ;;
esac
case "$source_root" in *[!A-Za-z0-9_./-]*) printf 'Source path contains unsupported characters.\n' >&2; exit 2 ;; esac

umask 077
mkdir -p "$destination/.incoming"
inventory=$(mktemp)
stage=""
cleanup() {
  rm -f "$inventory" ${selected:+"$selected"}
  [ -z "$stage" ] || rm -rf "$stage"
}
trap cleanup EXIT HUP INT TERM

# This program is intentionally passed to a local or remote POSIX shell.
# shellcheck disable=SC2016
inventory_script='root=$1
[ -d "$root" ] || exit 3
find "$root" -mindepth 3 -maxdepth 3 -type f -name manifest.json -print | while IFS= read -r manifest; do
  set_dir=${manifest%/manifest.json}
  id=${set_dir##*/}
  group_dir=${set_dir%/*}
  group=${group_dir##*/}
  case "$id" in ????-??-??T??-??-??Z) ;; *) continue ;; esac
  case "$group" in app-data|[A-Za-z0-9]*.[A-Za-z0-9]*) ;; *) continue ;; esac
  blocks=$(du -sk "$set_dir")
  blocks=${blocks%%[[:space:]]*}
  case "$blocks" in ""|*[!0-9]*) exit 4 ;; esac
  bytes=$((blocks * 1024))
  printf "%s\\t%s\\t%s\\n" "$group" "$id" "$bytes"
done'

if [ -n "$remote" ]; then
  # shellcheck disable=SC2086
  ssh $ssh_options "$remote" hosting-backup-inventory > "$inventory"
else
  sh -c "$inventory_script" sh "$source_root" > "$inventory"
fi

selected=$(mktemp)
sort -t '	' -k1,1 -k2,2r "$inventory" | awk -F '\t' -v keep="$retention" '
  $1 != current { current=$1; count=0 }
  count < keep { print; count++ }
' > "$selected"

verify_set() {
  directory=$1
  expected_group=$2
  expected_id=$3
  manifest="$directory/manifest.json"
  [ -f "$manifest" ] || { printf 'Missing manifest: %s\n' "$directory" >&2; return 1; }
  jq -e --arg id "$expected_id" --arg group "$expected_group" '
    .version == 2 and .id == $id and
    ((.type == "app-data" and $group == "app-data") or
     (.type == "site" and .domain == $group and (.websitePath | type == "string"))) and
    (.artifacts | type == "object")
  ' "$manifest" >/dev/null || { printf 'Manifest identity/contract failed: %s\n' "$directory" >&2; return 1; }

  type=$(jq -r .type "$manifest")
  if [ "$type" = app-data ]; then
    required="app-data.tar.gz databases.sql.gz"
  else
    required="website.tar.gz"
    [ "$(jq -r '.database // empty' "$manifest")" = "" ] || required="$required database.sql.gz"
  fi
  for artifact in $required; do
    [ -f "$directory/$artifact" ] || { printf 'Missing artifact %s in %s\n' "$artifact" "$directory" >&2; return 1; }
    expected_size=$(jq -er --arg file "$artifact" '.artifacts[$file].size' "$manifest") || return 1
    expected_sha=$(jq -er --arg file "$artifact" '.artifacts[$file].sha256' "$manifest") || return 1
    actual_size=$(wc -c < "$directory/$artifact" | tr -d ' ')
    [ "$actual_size" = "$expected_size" ] || { printf 'Size mismatch for %s\n' "$artifact" >&2; return 1; }
    actual_sha=$(sha256sum "$directory/$artifact" | awk '{print $1}')
    [ "$actual_sha" = "$expected_sha" ] || { printf 'Checksum mismatch for %s\n' "$artifact" >&2; return 1; }
  done
  if [ "$type" = app-data ]; then
    tar -tzf "$directory/app-data.tar.gz" >/dev/null
    gzip -t "$directory/databases.sql.gz"
  else
    website_path=$(jq -r .websitePath "$manifest")
    case "$website_path" in ''|/*|*..*) printf 'Unsafe website path in manifest.\n' >&2; return 1 ;; esac
    tar -tzf "$directory/website.tar.gz" | awk -v root="$website_path" '
      BEGIN { count=0 }
      /^\// { exit 1 }
      /(^|\/)\.\.($|\/)/ { exit 1 }
      { if ($0 != root && index($0, root "/") != 1) exit 1; count++ }
      END { if (count == 0) exit 1 }
    '
    [ "$(jq -r '.database // empty' "$manifest")" = "" ] || gzip -t "$directory/database.sql.gz"
  fi
}

reserve_bytes=$((reserve_gb * 1024 * 1024 * 1024))
received_groups=""
while IFS='	' read -r group id bytes; do
  [ -n "$group" ] || continue
  case "$bytes" in ''|*[!0-9]*) printf 'Invalid inventory size for %s/%s.\n' "$group" "$id" >&2; exit 1 ;; esac
  target="$destination/$group/$id"
  if [ -d "$target" ]; then
    verify_set "$target" "$group" "$id"
    printf 'Verified existing %s/%s\n' "$group" "$id"
    continue
  fi
  available_kb=$(df -Pk "$destination" | awk 'NR==2 {print $4}')
  available_bytes=$((available_kb * 1024))
  required_bytes=$((bytes + reserve_bytes))
  if [ "$available_bytes" -lt "$required_bytes" ]; then
    printf 'Insufficient space for %s/%s: need %s bytes plus reserve, have %s bytes.\n' "$group" "$id" "$bytes" "$available_bytes" >&2
    exit 1
  fi
  printf '%s %s/%s (%s bytes)\n' "$([ "$dry_run" -eq 1 ] && printf 'Would receive' || printf 'Receiving')" "$group" "$id" "$bytes"
  [ "$dry_run" -eq 0 ] || continue
  stage="$destination/.incoming/$group-$id.$$"
  rm -rf "$stage"
  mkdir -p "$stage" "$destination/$group"
  if [ -n "$remote" ]; then
    # shellcheck disable=SC2086
    rsync -a --partial -e "ssh $ssh_options" "$remote:$source_root/$group/$id/" "$stage/"
  else
    cp -a "$source_root/$group/$id/." "$stage/"
  fi
  verify_set "$stage" "$group" "$id"
  mv "$stage" "$target"
  stage=""
  received_groups="$received_groups $group"
  printf 'Promoted verified %s/%s\n' "$group" "$id"
done < "$selected"

if [ "$dry_run" -eq 0 ]; then
  for group in $(printf '%s\n' "$received_groups" | tr ' ' '\n' | awk 'NF && !seen[$0]++'); do
    count=0
    find "$destination/$group" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??-??-??Z' -print \
      | sort -r | while IFS= read -r set_dir; do
          count=$((count + 1))
          if [ "$count" -gt "$retention" ]; then rm -rf "$set_dir"; fi
        done
  done
fi

printf 'Backup reception complete.\n'
