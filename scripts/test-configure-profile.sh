#!/bin/sh

set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
configure="$project_dir/scripts/configure.sh"
install="$project_dir/scripts/install.sh"

assert_contains() {
  pattern="$1"
  grep -qF "$pattern" "$configure" || {
    printf 'Missing configure profile setting: %s\n' "$pattern" >&2
    exit 1
  }
}

assert_contains "STANDBY_PROFILE_NAME='standby-8gb'"
assert_contains "MYSQL_SERVER_ID=2"
assert_contains "MYSQL_INNODB_BUFFER_POOL_SIZE='1G'"
assert_contains "MYSQL_INNODB_REDO_LOG_CAPACITY='512M'"
assert_contains "MYSQL_MAX_CONNECTIONS=100"
assert_contains "REDIS_MAXMEMORY='256mb'"
assert_contains "PHP_GLOBAL_INI_PATH='/etc/hosting-control/php/global.ini'"

grep -qF 'cp "$project_dir/global-configs-new-upd/php/global.ini" "$php_global_ini_path"' "$install" || {
  printf 'Installer does not initialize the machine-local PHP configuration.\n' >&2
  exit 1
}
grep -qF 'chmod 640 "$php_global_ini_path"' "$install" || {
  printf 'Installer does not protect the machine-local PHP configuration.\n' >&2
  exit 1
}

printf 'configure standby profile checks passed\n'
