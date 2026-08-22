#!/bin/sh
set -eu

export RECEIVER_PROGRESS_INTERVAL_SECONDS=0

echo "Running receiver shell tests..."

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
script="$project_dir/scripts/receive-backups.sh"

inventory_progress_line=$(grep -n 'write_progress running' "$script" | sed -n '1s/:.*//p')
inventory_command_line=$(grep -n 'hosting-backup-inventory > "\$inventory"' "$script" | sed -n '1s/:.*//p')
if [ -z "$inventory_progress_line" ] || [ -z "$inventory_command_line" ] \
  || [ "$inventory_progress_line" -ge "$inventory_command_line" ]; then
  echo "FAIL: Receiver does not publish running progress before remote inventory"
  exit 1
fi

temp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT HUP INT TERM

src="$temp_dir/src"
dst="$temp_dir/dst"
mkdir -p "$src/example.com/2026-08-08T00-00-00Z" "$dst"

# Create valid website artifact
mkdir -p "$temp_dir/example.com"
echo "hello" > "$temp_dir/example.com/index.html"
tar -czf "$src/example.com/2026-08-08T00-00-00Z/website.tar.gz" -C "$temp_dir" example.com

size=$(wc -c < "$src/example.com/2026-08-08T00-00-00Z/website.tar.gz" | tr -d ' ')
sha=$(sha256sum "$src/example.com/2026-08-08T00-00-00Z/website.tar.gz" | awk '{print $1}')

cat > "$src/example.com/2026-08-08T00-00-00Z/manifest.json" <<EOF
{
  "version": 2,
  "type": "site",
  "id": "2026-08-08T00-00-00Z",
  "domain": "example.com",
  "websitePath": "example.com",
  "database": null,
  "startedAt": "2026-08-08T00:00:00Z",
  "completedAt": "2026-08-08T00:01:00.123Z",
  "artifacts": {
    "website.tar.gz": { "size": $size, "sha256": "$sha" }
  }
}
EOF

# The locked SSH reader and local inventory expose the same five fields used
# for coherent app-data cutoff selection.
reader_root_file="$temp_dir/backup-reader-root"
printf '%s\n' "$src" > "$reader_root_file"
reader_inventory=$(HOSTING_BACKUP_ROOT_FILE="$reader_root_file" SSH_ORIGINAL_COMMAND=hosting-backup-inventory "$project_dir/scripts/backup-reader-command.sh")
reader_fields=$(printf '%s\n' "$reader_inventory" | awk -F '\t' 'NR == 1 { print NF }')
reader_bytes=$(printf '%s\n' "$reader_inventory" | awk -F '\t' 'NR == 1 { print $3 }')
reader_sha=$(printf '%s\n' "$reader_inventory" | awk -F '\t' 'NR == 1 { print $4 }')
reader_epoch=$(printf '%s\n' "$reader_inventory" | awk -F '\t' 'NR == 1 { print $5 }')
expected_reader_bytes=$((size + $(wc -c < "$src/example.com/2026-08-08T00-00-00Z/manifest.json" | tr -d ' ')))
expected_reader_sha=$(sha256sum "$src/example.com/2026-08-08T00-00-00Z/manifest.json" | awk '{print $1}')
if [ "$reader_fields" -ne 5 ] || [ "$reader_bytes" -ne "$expected_reader_bytes" ] \
  || [ "$reader_sha" != "$expected_reader_sha" ] || [ "$reader_epoch" -le 0 ]; then
  echo "FAIL: Locked backup reader inventory protocol is incompatible"
  exit 1
fi

# Test malformed ID
if "$script" --source "$src" --destination "$dst" --source-server-id "bad id!" >/dev/null 2>&1; then
  echo "FAIL: Malformed source-server-id did not exit with error"
  exit 1
fi

# Test dry-run
"$script" --source "$src" --destination "$dst" --source-server-id "OPI5" --dry-run >/dev/null
if [ -f "$dst/receiver-state.json" ]; then
  echo "FAIL: Dry run wrote receipt"
  exit 1
fi
if [ -d "$dst/example.com/2026-08-08T00-00-00Z" ]; then
  echo "FAIL: Dry run created backup directory"
  exit 1
fi

# Test success
"$script" --source "$src" --destination "$dst" --source-server-id "OPI5" >/dev/null
if [ ! -f "$dst/receiver-state.json" ]; then
  echo "FAIL: Success did not write receipt"
  exit 1
fi
if [ ! -d "$dst/example.com/2026-08-08T00-00-00Z" ]; then
  echo "FAIL: Success did not create backup directory"
  exit 1
fi
if [ "$(jq -r .status "$dst/receiver-progress.json")" != succeeded ] \
  || [ "$(jq -r .completedSets "$dst/receiver-progress.json")" -ne 1 ] \
  || [ "$(jq -r .totalSets "$dst/receiver-progress.json")" -ne 1 ] \
  || [ "$(jq -r .completedBytes "$dst/receiver-progress.json")" -ne "$(jq -r .totalBytes "$dst/receiver-progress.json")" ]; then
  echo "FAIL: Success did not persist complete receiver progress"
  exit 1
fi

group_mode=$(stat -f '%Lp' "$dst/example.com" 2>/dev/null || stat -c '%a' "$dst/example.com")
if [ "$group_mode" != "750" ]; then
  echo "FAIL: Backup group mode is $group_mode, expected 750"
  exit 1
fi

receipt_mode=$(stat -f '%Lp' "$dst/receiver-state.json" 2>/dev/null || stat -c '%a' "$dst/receiver-state.json")
if [ "$receipt_mode" != "600" ]; then
  echo "FAIL: Receipt mode is $receipt_mode, expected 600"
  exit 1
fi
destination_owner=$(ls -nd "$dst" | awk '{print $3 ":" $4}')
receipt_owner=$(ls -nd "$dst/receiver-state.json" | awk '{print $3 ":" $4}')
if [ "$receipt_owner" != "$destination_owner" ]; then
  echo "FAIL: Receipt owner $receipt_owner does not match destination owner $destination_owner"
  exit 1
fi
progress_mode=$(stat -f '%Lp' "$dst/receiver-progress.json" 2>/dev/null || stat -c '%a' "$dst/receiver-progress.json")
progress_owner=$(ls -nd "$dst/receiver-progress.json" | awk '{print $3 ":" $4}')
if [ "$progress_mode" != "600" ] || [ "$progress_owner" != "$destination_owner" ]; then
  echo "FAIL: Receiver progress permissions are $progress_mode $progress_owner"
  exit 1
fi
set_owner=$(ls -nd "$dst/example.com/2026-08-08T00-00-00Z" | awk '{print $3 ":" $4}')
if [ "$set_owner" != "$destination_owner" ]; then
  echo "FAIL: Backup set owner $set_owner does not match destination owner $destination_owner"
  exit 1
fi

receipt_sets=$(jq '.sets | length' "$dst/receiver-state.json")
if [ "$receipt_sets" -ne 1 ]; then
  echo "FAIL: Expected 1 set in receipt, got $receipt_sets"
  exit 1
fi

# Test existing sets reuse their prior successful attestation.
existing_output=$("$script" --source "$src" --destination "$dst" --source-server-id "OPI5")
printf '%s' "$existing_output" | grep -q 'Reused prior attestation'
receipt_sets2=$(jq '.sets | length' "$dst/receiver-state.json")
if [ "$receipt_sets2" -ne 1 ]; then
  echo "FAIL: Expected 1 set in receipt for existing, got $receipt_sets2"
  exit 1
fi

# A changed manifest invalidates the prior attestation and forces full
# verification, which must reject a mismatched checksum.
cp "$src/example.com/2026-08-08T00-00-00Z/manifest.json" "$temp_dir/original-manifest.json"
jq '.artifacts["website.tar.gz"].sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' \
  "$temp_dir/original-manifest.json" > "$src/example.com/2026-08-08T00-00-00Z/manifest.json"
if "$script" --source "$src" --destination "$dst" --source-server-id "OPI5" >/dev/null 2>&1; then
  echo "FAIL: Changed manifest reused a stale attestation"
  exit 1
fi
cp "$temp_dir/original-manifest.json" "$src/example.com/2026-08-08T00-00-00Z/manifest.json"

# Test: an empty source fails closed and preserves the previous receipt
empty_src="$temp_dir/empty-source"
mkdir -p "$empty_src"
old_empty_inode=$(ls -i "$dst/receiver-state.json" | awk '{print $1}')
if "$script" --source "$empty_src" --destination "$dst" --source-server-id "OPI5" >/dev/null 2>&1; then
  echo "FAIL: Empty source reported success"
  exit 1
fi
new_empty_inode=$(ls -i "$dst/receiver-state.json" | awk '{print $1}')
if [ "$old_empty_inode" != "$new_empty_inode" ]; then
  echo "FAIL: Empty source replaced the previous receipt"
  exit 1
fi
if [ "$(jq -r .status "$dst/receiver-progress.json")" != failed ]; then
  echo "FAIL: Empty source did not record failed receiver progress"
  exit 1
fi

# Test failed verification (no partial receipt, atomic replacement)
old_receipt_inode=$(ls -i "$dst/receiver-state.json" | awk '{print $1}')
mkdir -p "$src/example.com/2026-08-09T00-00-00Z"
cp "$src/example.com/2026-08-08T00-00-00Z/website.tar.gz" "$src/example.com/2026-08-09T00-00-00Z/"
cat > "$src/example.com/2026-08-09T00-00-00Z/manifest.json" <<EOF
{
  "version": 2,
  "type": "site",
  "id": "2026-08-09T00-00-00Z",
  "domain": "example.com",
  "websitePath": "example.com",
  "database": null,
  "startedAt": "2026-08-09T00:00:00Z",
  "completedAt": "2026-08-09T00:01:00Z",
  "artifacts": {
    "website.tar.gz": { "size": 99999, "sha256": "$sha" }
  }
}
EOF
if "$script" --source "$src" --destination "$dst" --source-server-id "OPI5" >/dev/null 2>&1; then
  echo "FAIL: Failed verification did not exit with error"
  exit 1
fi
new_receipt_inode=$(ls -i "$dst/receiver-state.json" | awk '{print $1}')
if [ "$old_receipt_inode" != "$new_receipt_inode" ]; then
  echo "FAIL: Failed verification replaced the receipt"
  exit 1
fi
if [ -d "$dst/example.com/2026-08-09T00-00-00Z" ]; then
  echo "FAIL: Failed verification left partial directory"
  exit 1
fi
if [ -d "$dst/.incoming" ] && [ "$(ls -A "$dst/.incoming")" ]; then
  echo "FAIL: Failed verification left files in .incoming"
  exit 1
fi

# Test: retention=2 keeps a prior local generation while the receipt attests
# only the newest selected generation.
cat > "$src/example.com/2026-08-09T00-00-00Z/manifest.json" <<EOF
{
  "version": 2,
  "type": "site",
  "id": "2026-08-09T00-00-00Z",
  "domain": "example.com",
  "websitePath": "example.com",
  "database": null,
  "startedAt": "2026-08-09T00:00:00Z",
  "completedAt": "2026-08-09T00:01:00Z",
  "artifacts": {
    "website.tar.gz": { "size": $size, "sha256": "$sha" }
  }
}
EOF
"$script" --source "$src" --destination "$dst" --source-server-id "OPI5" --retention 2 >/dev/null
receipt_sets_retention=$(jq '.sets | length' "$dst/receiver-state.json")
retained_directories=$(find "$dst/example.com" -mindepth 1 -maxdepth 1 -type d -name '????-??-??T??-??-??Z' | wc -l | tr -d ' ')
if [ "$receipt_sets_retention" -ne 1 ] || [ "$retained_directories" -ne 2 ]; then
  echo "FAIL: Expected one current receipt set and two retained directories, got $receipt_sets_retention/$retained_directories"
  exit 1
fi

# Test: stale JSONL doesn't leak
mkdir -p "$dst/.incoming"
echo '{"domain":"stale","setId":"123","manifestSha256":"abc"}' > "$dst/.incoming/verified_sets.jsonl"
"$script" --source "$src" --destination "$dst" --source-server-id "OPI5" >/dev/null
stale_count=$(jq '[.sets[] | select(.domain == "stale")] | length' "$dst/receiver-state.json")
if [ "$stale_count" -ne 0 ]; then
  echo "FAIL: Stale JSONL leaked into receipt"
  exit 1
fi

# Test: app-data in receipt
mkdir -p "$temp_dir/configs" "$src/app-data/2026-08-10T00-00-00Z"
echo 'x' > "$temp_dir/configs/test.conf"
tar -czf "$src/app-data/2026-08-10T00-00-00Z/app-data.tar.gz" -C "$temp_dir" configs
echo 'CREATE DATABASE test;' | gzip > "$src/app-data/2026-08-10T00-00-00Z/databases.sql.gz"

app_data_size=$(wc -c < "$src/app-data/2026-08-10T00-00-00Z/app-data.tar.gz" | tr -d ' ')
app_data_sha=$(sha256sum "$src/app-data/2026-08-10T00-00-00Z/app-data.tar.gz" | awk '{print $1}')
db_size=$(wc -c < "$src/app-data/2026-08-10T00-00-00Z/databases.sql.gz" | tr -d ' ')
db_sha=$(sha256sum "$src/app-data/2026-08-10T00-00-00Z/databases.sql.gz" | awk '{print $1}')

cat > "$src/app-data/2026-08-10T00-00-00Z/manifest.json" <<EOF
{
  "version": 2,
  "type": "app-data",
  "id": "2026-08-10T00-00-00Z",
  "excluded": ["mysql", "nginx-cache"],
  "startedAt": "2026-08-10T00:00:00Z",
  "completedAt": "2026-08-10T00:01:00Z",
  "artifacts": {
    "app-data.tar.gz": { "size": $app_data_size, "sha256": "$app_data_sha" },
    "databases.sql.gz": { "size": $db_size, "sha256": "$db_sha" }
  }
}
EOF

"$script" --source "$src" --destination "$dst" --source-server-id "OPI5" >/dev/null
app_data_count=$(jq '[.sets[] | select(.domain == "app-data")] | length' "$dst/receiver-state.json")
if [ "$app_data_count" -eq 0 ]; then
  echo "FAIL: app-data not found in receipt"
  exit 1
fi

# A site completed after the newest app-data snapshot is not a coherent
# recovery point and must be deferred until a later app-data backup exists.
mkdir -p "$src/example.com/2026-08-11T00-00-00Z"
cp "$src/example.com/2026-08-09T00-00-00Z/website.tar.gz" "$src/example.com/2026-08-11T00-00-00Z/"
cat > "$src/example.com/2026-08-11T00-00-00Z/manifest.json" <<EOF
{
  "version": 2,
  "type": "site",
  "id": "2026-08-11T00-00-00Z",
  "domain": "example.com",
  "websitePath": "example.com",
  "database": null,
  "startedAt": "2026-08-11T00:00:00Z",
  "completedAt": "2026-08-11T00:01:00Z",
  "artifacts": {
    "website.tar.gz": { "size": $size, "sha256": "$sha" }
  }
}
EOF
"$script" --source "$src" --destination "$dst" --source-server-id "OPI5" >/dev/null
selected_site_id=$(jq -r '.sets[] | select(.domain == "example.com") | .setId' "$dst/receiver-state.json")
if [ "$selected_site_id" != "2026-08-09T00-00-00Z" ]; then
  echo "FAIL: Receiver selected site set newer than app-data cutoff: $selected_site_id"
  exit 1
fi

# Test: bounded ID (65 chars rejected, 64 chars accepted)
id_64="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
if ! "$script" --source "$src" --destination "$dst" --source-server-id "$id_64" >/dev/null; then
  echo "FAIL: 64-character source-server-id was rejected"
  exit 1
fi

id_65="${id_64}x"
if "$script" --source "$src" --destination "$dst" --source-server-id "$id_65" >/dev/null 2>&1; then
  echo "FAIL: 65-character source-server-id was accepted"
  exit 1
fi

echo "Receiver shell tests passed."
