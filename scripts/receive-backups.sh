#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: receive-backups.sh --source PATH|USER@HOST:/PATH --destination PATH [options]

Options:
  --source-server-id ID Identifier of the source server (required; 1-64 alphanumeric/hyphen/underscore/dot chars)
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
source_server_id=""
progress_interval="${RECEIVER_PROGRESS_INTERVAL_SECONDS:-5}"


while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; source_spec="$1" ;;
    --destination) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; destination="$1" ;;
    --retention) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; retention="$1" ;;
    --reserve-gb) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; reserve_gb="$1" ;;
    --ssh-option) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; ssh_options="$ssh_options $1" ;;
    --source-server-id) shift; [ "$#" -gt 0 ] || { usage; exit 2; }; source_server_id="$1" ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
  shift
done

[ -n "$source_spec" ] && [ -n "$destination" ] && [ -n "$source_server_id" ] || { usage; exit 2; }
case "$source_server_id" in ''|*[!A-Za-z0-9._-]*) printf 'Source server ID must be 1-64 alphanumeric, dot, hyphen, or underscore chars.\n' >&2; exit 2 ;; esac
if [ "${#source_server_id}" -gt 64 ]; then printf 'Source server ID must be at most 64 characters.\n' >&2; exit 2; fi
case "$retention" in ''|*[!0-9]*) printf 'Retention must be an integer.\n' >&2; exit 2 ;; esac
case "$reserve_gb" in ''|*[!0-9]*) printf 'Reserve must be an integer number of GiB.\n' >&2; exit 2 ;; esac
case "$progress_interval" in ''|*[!0-9]*) printf 'Progress interval must be an integer.\n' >&2; exit 2 ;; esac
[ "$retention" -ge 1 ] && [ "$retention" -le 30 ] || { printf 'Retention must be from 1 to 30.\n' >&2; exit 2; }
[ "$reserve_gb" -le 100000 ] || { printf 'Reserve is too large.\n' >&2; exit 2; }
[ "$progress_interval" -le 60 ] || { printf 'Progress interval must be from 0 to 60 seconds.\n' >&2; exit 2; }
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
destination_owner=$(ls -nd "$destination" | awk '{print $3 ":" $4}')
inventory=$(mktemp)
stage=""
progress_active=0
progress_path="$destination/receiver-progress.json"
progress_started=""
progress_completed=0
progress_total=0
progress_group=""
progress_set_id=""
progress_total_bytes=0
progress_completed_bytes=0
progress_current_bytes=0
progress_current_received_bytes=0
transfer_pid=""

write_progress() {
  progress_status="$1"
  progress_finished=""
  [ "$progress_status" = running ] || progress_finished="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  progress_tmp="$destination/.incoming/receiver-progress.$$.json"
  jq -n --arg status "$progress_status" --arg startedAt "$progress_started" \
    --arg finishedAt "$progress_finished" --arg sourceServerId "$source_server_id" \
    --arg currentGroup "$progress_group" --arg currentSetId "$progress_set_id" \
    --argjson completedSets "$progress_completed" --argjson totalSets "$progress_total" \
    --argjson totalBytes "$progress_total_bytes" --argjson completedBytes "$progress_completed_bytes" \
    --argjson currentSetBytes "$progress_current_bytes" --argjson currentSetReceivedBytes "$progress_current_received_bytes" \
    '{version:1,status:$status,startedAt:$startedAt,finishedAt:$finishedAt,
      sourceServerId:$sourceServerId,totalSets:$totalSets,completedSets:$completedSets,
      totalBytes:$totalBytes,completedBytes:$completedBytes,currentSetBytes:$currentSetBytes,
      currentSetReceivedBytes:$currentSetReceivedBytes,currentGroup:$currentGroup,currentSetId:$currentSetId}' > "$progress_tmp"
  chown "$destination_owner" "$progress_tmp"
  chmod 600 "$progress_tmp"
  mv "$progress_tmp" "$progress_path"
}

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$progress_active" -eq 1 ]; then
    write_progress failed || true
  fi
  [ -z "$transfer_pid" ] || kill "$transfer_pid" >/dev/null 2>&1 || true
  rm -f "$inventory" ${selected:+"$selected"}
  [ -z "$stage" ] || rm -rf "$stage"
  rm -f "$destination/.incoming/verified_sets.jsonl"
}
trap cleanup EXIT HUP INT TERM

if [ "$dry_run" -eq 0 ]; then
  progress_started="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  progress_active=1
  write_progress running
fi

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
  jq -e --arg id "$id" --arg group "$group" '\''
    .version == 2 and .id == $id and
    ((.type == "app-data" and $group == "app-data") or
     (.type == "site" and .domain == $group)) and
    (.artifacts | type == "object")
  '\'' "$manifest" >/dev/null 2>&1 || continue
  artifact_bytes=$(jq -er '\''
    [.artifacts[]?.size] |
    if length == 0 or length > 16 or
       any(.[]; (type != "number") or (. < 0) or (. > 107374182400) or (. != floor))
    then error("invalid artifact sizes") else add end
  '\'' "$manifest") || continue
  manifest_bytes=$(wc -c < "$manifest" | tr -d " ")
  case "$artifact_bytes:$manifest_bytes" in *[!0-9:]*|:*) continue ;; esac
  bytes=$((artifact_bytes + manifest_bytes))
  manifest_sha=$(sha256sum "$manifest" | awk '\''{print $1}'\'')
  completed_epoch=$(jq -er '\''.completedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601'\'' "$manifest") || continue
  printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$group" "$id" "$bytes" "$manifest_sha" "$completed_epoch"
done'

if [ -n "$remote" ]; then
  # shellcheck disable=SC2086
  ssh $ssh_options "$remote" hosting-backup-inventory > "$inventory"
else
  sh -c "$inventory_script" sh "$source_root" > "$inventory"
fi

selected=$(mktemp)
# Receive only the newest complete set per group. Destination retention is
# independent, so one older local generation remains without being rehashed on
# every reception run. When app-data exists, its newest completion timestamp is
# the consistency cutoff: later website archives cannot be restored with that
# database snapshot and are deferred to the next coherent receive.
app_data_cutoff=$(awk -F '\t' '$1 == "app-data" && $5 > latest { latest=$5 } END { print latest + 0 }' "$inventory")
sort -t '	' -k1,1 -k2,2r "$inventory" | awk -F '\t' -v keep=1 -v cutoff="$app_data_cutoff" '
  $1 != "app-data" && cutoff > 0 && $5 > cutoff { next }
  $1 != current { current=$1; count=0 }
  count < keep { print; count++ }
' > "$selected"

if [ "$dry_run" -eq 0 ]; then
  progress_total="$(awk 'NF { count++ } END { print count + 0 }' "$selected")"
  progress_total_bytes="$(awk -F '\t' 'NF { total += $3 } END { printf "%.0f", total + 0 }' "$selected")"
  write_progress running
fi

verify_set() {
  directory=$1
  expected_group=$2
  expected_id=$3
  manifest="$directory/manifest.json"
  [ -f "$manifest" ] || { printf 'Missing manifest: %s\n' "$directory" >&2; return 1; }
  jq -e --arg id "$expected_id" --arg group "$expected_group" '
    .version == 2 and .id == $id and
    (.startedAt | type == "string") and (.completedAt | type == "string") and
    ((.type == "app-data" and $group == "app-data" and
      (.excluded | type == "array") and
      ((.artifacts | keys | sort) == ["app-data.tar.gz", "databases.sql.gz"])) or
     (.type == "site" and .domain == $group and has("database") and
      (.websitePath | type == "string") and
      ((.database == null and ((.artifacts | keys | sort) == ["website.tar.gz"])) or
       ((.database | type == "string") and ((.artifacts | keys | sort) == ["database.sql.gz", "website.tar.gz"])))) )
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

reuse_prior_attestation() {
  directory=$1
  expected_group=$2
  expected_id=$3
  expected_manifest_sha=$4
  prior_receipt="$destination/receiver-state.json"
  manifest="$directory/manifest.json"
  [ -f "$prior_receipt" ] && [ -f "$manifest" ] || return 1
  manifest_sha=$(sha256sum "$manifest" | awk '{print $1}')
  [ "$manifest_sha" = "$expected_manifest_sha" ] || return 1
  jq -e --arg source "$source_server_id" --arg group "$expected_group" --arg id "$expected_id" --arg sha "$manifest_sha" '
    .version == 1 and .result == "success" and .sourceServerId == $source and
    any(.sets[]; .domain == $group and .setId == $id and .manifestSha256 == $sha)
  ' "$prior_receipt" >/dev/null 2>&1 || return 1
  jq -e --arg id "$expected_id" --arg group "$expected_group" '
    .version == 2 and .id == $id and
    ((.type == "app-data" and $group == "app-data" and
      ((.artifacts | keys | sort) == ["app-data.tar.gz", "databases.sql.gz"])) or
     (.type == "site" and .domain == $group and
      ((.database == null and ((.artifacts | keys | sort) == ["website.tar.gz"])) or
       ((.database | type == "string") and ((.artifacts | keys | sort) == ["database.sql.gz", "website.tar.gz"])))) )
  ' "$manifest" >/dev/null 2>&1 || return 1
  for artifact in $(jq -r '.artifacts | keys[]' "$manifest"); do
    [ -f "$directory/$artifact" ] || return 1
    expected_size=$(jq -er --arg file "$artifact" '.artifacts[$file].size' "$manifest") || return 1
    actual_size=$(wc -c < "$directory/$artifact" | tr -d ' ')
    [ "$actual_size" = "$expected_size" ] || return 1
  done
  return 0
}

reserve_bytes=$((reserve_gb * 1024 * 1024 * 1024))
received_groups=""
[ "$dry_run" -eq 1 ] || : > "$destination/.incoming/verified_sets.jsonl"
while IFS='	' read -r group id bytes source_manifest_sha source_completed_epoch; do
  [ -n "$group" ] || continue
  if [ "$dry_run" -eq 0 ]; then
    progress_group="$group"
    progress_set_id="$id"
    progress_current_bytes="$bytes"
    progress_current_received_bytes=0
    write_progress running
  fi
  received_groups="$received_groups $group"
  case "$bytes" in ''|*[!0-9]*) printf 'Invalid inventory size for %s/%s.\n' "$group" "$id" >&2; exit 1 ;; esac
  case "$source_manifest_sha" in ''|*[!a-f0-9]*) printf 'Invalid manifest checksum for %s/%s.\n' "$group" "$id" >&2; exit 1 ;; esac
  [ "${#source_manifest_sha}" -eq 64 ] || { printf 'Invalid manifest checksum for %s/%s.\n' "$group" "$id" >&2; exit 1; }
  group_dir="$destination/$group"
  mkdir -p "$group_dir"
  chown "$destination_owner" "$group_dir"
  chmod 750 "$group_dir"
  target="$group_dir/$id"
  if [ -d "$target" ]; then
    local_manifest_sha=$(sha256sum "$target/manifest.json" 2>/dev/null | awk '{print $1}')
    [ "$local_manifest_sha" = "$source_manifest_sha" ] \
      || { printf 'Immutable set collision for %s/%s.\n' "$group" "$id" >&2; exit 1; }
    if reuse_prior_attestation "$target" "$group" "$id" "$source_manifest_sha"; then
      printf 'Reused prior attestation for %s/%s\n' "$group" "$id"
    else
      verify_set "$target" "$group" "$id"
      printf 'Verified existing %s/%s\n' "$group" "$id"
    fi
    chown -R "$destination_owner" "$target"
    if [ "$dry_run" -eq 0 ]; then
      manifest_sha=$(sha256sum "$target/manifest.json" | awk '{print $1}')
      jq -n -c --arg domain "$group" --arg setId "$id" --arg manifestSha256 "$manifest_sha" \
        '{domain: $domain, setId: $setId, manifestSha256: $manifestSha256}' >> "$destination/.incoming/verified_sets.jsonl"
      progress_completed=$((progress_completed + 1))
      progress_completed_bytes=$((progress_completed_bytes + bytes))
      progress_current_received_bytes="$bytes"
      write_progress running
    fi
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
  mkdir -p "$stage"
  if [ -n "$remote" ]; then
    # shellcheck disable=SC2086
    rsync -a --partial -e "ssh $ssh_options" "$remote:$source_root/$group/$id/" "$stage/" &
  else
    cp -a "$source_root/$group/$id/." "$stage/" &
  fi
  transfer_pid=$!
  while kill -0 "$transfer_pid" >/dev/null 2>&1; do
    transferred_kb=$(du -sk "$stage" | awk '{print $1}')
    case "$transferred_kb" in ''|*[!0-9]*) transferred_kb=0 ;; esac
    progress_current_received_bytes=$((transferred_kb * 1024))
    if [ "$progress_current_received_bytes" -gt "$progress_current_bytes" ]; then
      progress_current_received_bytes="$progress_current_bytes"
    fi
    write_progress running
    [ "$progress_interval" -eq 0 ] || sleep "$progress_interval"
  done
  if ! wait "$transfer_pid"; then
    transfer_pid=""
    printf 'Transfer failed for %s/%s.\n' "$group" "$id" >&2
    exit 1
  fi
  transfer_pid=""
  verify_set "$stage" "$group" "$id"
  chown -R "$destination_owner" "$stage"
  mv "$stage" "$target"
  stage=""
  printf 'Promoted verified %s/%s\n' "$group" "$id"
  if [ "$dry_run" -eq 0 ]; then
    manifest_sha=$(sha256sum "$target/manifest.json" | awk '{print $1}')
    jq -n -c --arg domain "$group" --arg setId "$id" --arg manifestSha256 "$manifest_sha" \
      '{domain: $domain, setId: $setId, manifestSha256: $manifestSha256}' >> "$destination/.incoming/verified_sets.jsonl"
    progress_completed=$((progress_completed + 1))
    progress_completed_bytes=$((progress_completed_bytes + bytes))
    progress_current_received_bytes="$bytes"
    write_progress running
  fi
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

  if [ -f "$destination/.incoming/verified_sets.jsonl" ]; then
    sets_json=$(jq -s 'unique_by(.domain + "/" + .setId)' "$destination/.incoming/verified_sets.jsonl")
    verified_count=$(printf '%s' "$sets_json" | jq 'length')
  else
    sets_json="[]"
    verified_count=0
  fi
  if [ "$verified_count" -eq 0 ]; then
    printf 'No verified backup sets were selected; preserving the previous receipt.\n' >&2
    exit 1
  fi
  if [ "$verified_count" -gt 5000 ]; then
    printf 'Receipt has too many entries (%s).\n' "$verified_count" >&2
    exit 1
  fi
  completed_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tmp_receipt="$destination/.incoming/receipt.$$.json"
  jq -n \
    --arg completedAt "$completed_at" \
    --arg sourceServerId "$source_server_id" \
    --argjson verifiedCount "$verified_count" \
    --argjson sets "$sets_json" \
    '{version: 1, completedAt: $completedAt, result: "success", sourceServerId: $sourceServerId, verifiedCount: $verifiedCount, sets: $sets}' > "$tmp_receipt"
  chmod 600 "$tmp_receipt"
  receipt_owner=$(ls -nd "$tmp_receipt" | awk '{print $3 ":" $4}')
  if [ "$receipt_owner" != "$destination_owner" ]; then
    chown "$destination_owner" "$tmp_receipt"
  fi
  mv "$tmp_receipt" "$destination/receiver-state.json"
  progress_group=""
  progress_set_id=""
  progress_completed_bytes="$progress_total_bytes"
  progress_current_bytes=0
  progress_current_received_bytes=0
  write_progress succeeded
fi

printf 'Backup reception complete.\n'
