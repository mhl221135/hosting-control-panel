const assert = require("node:assert/strict");
const test = require("node:test");
const { validateArgs, validateCopy } = require("../app/policy");

test("allows bounded runtime inspection and reloads", () => {
  assert.doesNotThrow(() => validateArgs(["inspect", "--format", "{{json .State}}", "hosting-ui"]));
  assert.doesNotThrow(() => validateArgs(["exec", "hosting-nginx", "nginx", "-t"]));
  assert.doesNotThrow(() => validateArgs(["exec", "hosting-php-fpm", "sh", "-c", "kill -USR2 1"]));
  assert.doesNotThrow(() => validateArgs(["exec", "hosting-redis", "redis-cli", "CONFIG", "SET", "maxmemory", "4096mb"]));
});

test("allows constrained WordPress and MySQL operations", () => {
  assert.doesNotThrow(() => validateArgs([
    "exec", "-u", "33:33", "hosting-php-fpm", "wp", "--allow-root",
    "plugin", "update", "example", "--path=/var/www/example.com",
  ]));
  assert.doesNotThrow(() => validateArgs([
    "exec", "-e", "MIGRATION_SQL=SELECT 1", "hosting-db", "sh", "-c",
    'exec mysql -N -uroot -p"$MYSQL_ROOT_PASSWORD" -e "$MIGRATION_SQL"',
  ]));
  assert.doesNotThrow(() => validateArgs([
    "exec", "hosting-db", "sh", "-c",
    'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec nice -n 10 mysqldump -uroot "$@"',
    "backup-mysqldump", "--single-transaction", "--quick", "--routines",
    "--events", "--triggers", "--hex-blob", "example_db",
  ]));
  assert.doesNotThrow(() => validateArgs([
    "exec", "-i", "hosting-db", "sh", "-c",
    'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec nice -n 10 mysql -uroot "$1"',
    "backup-restore", "example_db",
  ]));
});

test("allows bounded statistics and application health probes", () => {
  assert.doesNotThrow(() => validateArgs([
    "stats", "--no-stream", "--format", "{{json .}}",
    "hosting-agent", "hosting-ui", "hosting-php-fpm",
  ]));
  assert.doesNotThrow(() => validateArgs([
    "exec", "hosting-nginx", "wget", "-q", "--spider",
    "--header", "Host: example.com", "http://127.0.0.1/admin/",
  ]));
  assert.doesNotThrow(() => validateArgs([
    "exec",
    "-e", "SCRIPT_FILENAME=/global/opcache-status.php",
    "-e", "SCRIPT_NAME=/opcache-status.php",
    "-e", "REQUEST_METHOD=GET",
    "-e", "REQUEST_URI=/opcache-status.php",
    "-e", "SERVER_PROTOCOL=HTTP/1.1",
    "-e", "GATEWAY_INTERFACE=CGI/1.1",
    "-e", "REDIRECT_STATUS=200",
    "hosting-php-fpm", "cgi-fcgi", "-bind", "-connect", "127.0.0.1:9000",
  ]));
});

test("rejects host-control and command-injection paths", () => {
  assert.throws(() => validateArgs(["run", "--privileged", "-v", "/:/host", "alpine"]), /not allowed/);
  assert.throws(() => validateArgs(["exec", "hosting-ui", "sh"]), /not allowed/);
  assert.throws(() => validateArgs(["exec", "hosting-php-fpm", "sh", "-c", "cat /etc/shadow"]), /not allowed/);
  assert.throws(() => validateArgs([
    "exec", "hosting-php-fpm", "wp", "--allow-root", "core", "version",
    "--exec=system('id')", "--path=/var/www/example.com",
  ]), /not allowed/);
  assert.throws(() => validateArgs(["exec", "hosting-nginx", "nginx", "-s", "quit"]), /not allowed/);
  assert.throws(() => validateArgs(["inspect", "--format", "{{json .Config}}", "hosting-ui"]), /not allowed/);
});

test("allows only package copies into the PHP temporary directory", () => {
  assert.doesNotThrow(() => validateArgs([
    "exec", "-i", "-u", "33:33", "hosting-php-fpm", "sh", "-c",
    'umask 077; cat > "$1"', "package-copy", "/tmp/hosting-package-plugin.zip",
  ]));
  assert.deepEqual(validateCopy("hosting-php-fpm:/tmp/hosting-control-plugin.zip"), {
    container: "hosting-php-fpm",
    path: "/tmp/hosting-control-plugin.zip",
  });
  assert.throws(() => validateCopy("hosting-php-fpm:/var/www/example.com/backdoor.php"), /not allowed/);
  assert.throws(() => validateCopy("hosting-ui:/tmp/hosting-control-plugin.zip"), /not allowed/);
});
