#!/bin/sh

set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
target="${1:-}"

prompt_required() {
  label="$1"
  while :; do
    printf "%s: " "$label" >&2
    IFS= read -r value
    [ -n "$value" ] && { ANSWER="$value"; return; }
    printf "A value is required.\n" >&2
  done
}

prompt_secret() {
  printf "%s: " "$1" >&2
  stty -echo
  IFS= read -r ANSWER
  stty echo
  printf "\n" >&2
  [ -n "$ANSWER" ] || { printf "A value is required.\n" >&2; exit 1; }
}

cleanup() {
  stty echo 2>/dev/null || true
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY RESTIC_PASSWORD RESTIC_REPOSITORY AWS_DEFAULT_REGION
}
trap cleanup EXIT HUP INT TERM

if [ -z "$target" ]; then
  prompt_required "Empty absolute restore directory"
  target="$ANSWER"
fi
case "$target" in
  /*) ;;
  *) printf "Restore directory must be absolute.\n" >&2; exit 1 ;;
esac
mkdir -p "$target"
[ -z "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
  printf "Restore directory must be empty: %s\n" "$target" >&2
  exit 1
}

prompt_required "Restic repository URL (s3:https://endpoint/bucket/prefix)"
RESTIC_REPOSITORY="$ANSWER"
case "$RESTIC_REPOSITORY" in
  s3:https://*) ;;
  *) printf "Only an S3 repository with an HTTPS endpoint is accepted.\n" >&2; exit 1 ;;
esac
prompt_required "S3 access key ID"
AWS_ACCESS_KEY_ID="$ANSWER"
prompt_secret "S3 secret access key"
AWS_SECRET_ACCESS_KEY="$ANSWER"
prompt_secret "Restic repository password"
RESTIC_PASSWORD="$ANSWER"
prompt_required "S3 region"
AWS_DEFAULT_REGION="$ANSWER"
printf "Snapshot ID [latest]: " >&2
IFS= read -r snapshot
snapshot="${snapshot:-latest}"

export RESTIC_REPOSITORY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY RESTIC_PASSWORD AWS_DEFAULT_REGION

cd "$project_dir"
printf "Listing encrypted snapshots...\n" >&2
docker compose run --rm --no-deps \
  -e RESTIC_REPOSITORY -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  -e RESTIC_PASSWORD -e AWS_DEFAULT_REGION \
  hosting-ui restic snapshots --tag hosting-control

printf "Checking repository metadata before restore...\n" >&2
docker compose run --rm --no-deps \
  -e RESTIC_REPOSITORY -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  -e RESTIC_PASSWORD -e AWS_DEFAULT_REGION \
  hosting-ui restic check

printf "Restore snapshot %s into %s? Type RESTORE: " "$snapshot" "$target" >&2
IFS= read -r confirmation
[ "$confirmation" = "RESTORE" ] || { printf "Recovery cancelled.\n" >&2; exit 1; }

docker compose run --rm --no-deps \
  -v "$target:/restore" \
  -e RESTIC_REPOSITORY -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  -e RESTIC_PASSWORD -e AWS_DEFAULT_REGION \
  hosting-ui restic restore "$snapshot" --target /restore

printf "Restore completed in %s. Inspect manifests before importing data.\n" "$target" >&2
