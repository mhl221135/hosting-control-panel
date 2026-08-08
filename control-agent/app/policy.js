const crypto = require("crypto");

const CONTAINERS = new Set([
  "hosting-db",
  "hosting-nginx",
  "hosting-php-fpm",
  "hosting-redis",
]);
const EXEC_CONTAINERS = new Set([...CONTAINERS, "hosting-npm"]);
const INSPECT_CONTAINERS = new Set([
  ...CONTAINERS,
  "hosting-agent",
  "hosting-billing",
  "hosting-cloudflared",
  "hosting-files",
  "hosting-npm",
  "hosting-phpmyadmin",
  "hosting-ui",
]);
const WP_COMMANDS = new Set([
  "comment", "config", "core", "cron", "db", "eval", "maintenance-mode",
  "option", "plugin", "post", "redis", "rewrite", "search-replace", "theme",
  "transient",
]);
const WP_BLOCKED_OPTIONS = ["--exec", "--http", "--prompt", "--require", "--ssh"];
const MYSQL_SCRIPTS = new Set([
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "$SITE_PROVISION_SQL"',
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "$SITE_REMOVAL_SQL"',
  'exec mysql -N -uroot -p"$MYSQL_ROOT_PASSWORD" -e "$MIGRATION_SQL"',
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "$MIGRATION_SQL"',
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "$MYSQL_PERFORMANCE_SQL"',
  'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec nice -n 10 mysql -uroot "$1"',
  'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec nice -n 10 mysqldump -uroot "$@"',
  'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec nice -n 10 mysqldump -uroot --single-transaction --quick --routines --events --triggers --hex-blob "$1"',
  'mysqladmin -uroot -p"$MYSQL_ROOT_PASSWORD" ping --silent',
  'mysqladmin -uroot -p"$MYSQL_ROOT_PASSWORD" ping',
]);
const PHP_SHELL_SCRIPTS = new Set([
  "kill -USR2 1",
  'umask 077; cat > "$1"',
  'set -eu; wp --allow-root config get DB_NAME --path="$1" --quiet; wp --allow-root config get DB_USER --path="$1" --quiet',
]);
const ENV_KEYS = new Set([
  "GATEWAY_INTERFACE", "MIGRATION_SQL", "MYSQL_PERFORMANCE_SQL",
  "REDIRECT_STATUS", "REQUEST_METHOD", "REQUEST_URI", "SCRIPT_FILENAME",
  "SCRIPT_NAME", "SERVER_PROTOCOL", "SITE_PROVISION_SQL", "SITE_REMOVAL_SQL",
]);
const SAFE_NAME = /^hosting-[a-z0-9-]+$/;
const SAFE_SITE_PATH = /^\/var\/www\/[A-Za-z0-9._/-]+$/;
const SAFE_TEMP_ZIP = /^\/tmp\/hosting-(?:control|package)-[A-Za-z0-9._-]+\.zip$/;
const IDENTIFIER = /^[A-Za-z0-9_$-]{1,64}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const NPM_BACKUP_READ_SCRIPT = "set -eu; find /etc/letsencrypt -xdev -exec chgrp -h 33 {} +; find /etc/letsencrypt -xdev -type d -exec chmod g+rX {} +; find /etc/letsencrypt -xdev -type f -exec chmod g+r {} +";

function deny(message) {
  const error = new Error(message);
  error.statusCode = 403;
  throw error;
}

function boundedText(value, maximum = 16_384) {
  const text = String(value);
  if (text.includes("\0") || Buffer.byteLength(text) > maximum) deny("Argument is invalid or too large");
  return text;
}

function validContainer(value, allowed = CONTAINERS) {
  const name = boundedText(value, 128);
  if (!SAFE_NAME.test(name) || !allowed.has(name)) deny(`Container is not allowed: ${name}`);
  return name;
}

function validSitePath(value) {
  const path = boundedText(value, 1024);
  if (!SAFE_SITE_PATH.test(path) || path.includes("/../") || path.endsWith("/..")) deny("Website path is not allowed");
  return path;
}

function parseExec(argv) {
  const options = [];
  const environment = {};
  let index = 1;
  while (index < argv.length) {
    const item = argv[index];
    if (item === "-i") {
      options.push(item);
      index += 1;
      continue;
    }
    if (item === "-u") {
      if (argv[index + 1] !== "33:33") deny("Only the website runtime user is allowed");
      options.push(item, argv[index + 1]);
      index += 2;
      continue;
    }
    if (item === "-e") {
      const assignment = boundedText(argv[index + 1]);
      const separator = assignment.indexOf("=");
      const key = assignment.slice(0, separator);
      if (separator < 1 || !ENV_KEYS.has(key)) deny("Container environment key is not allowed");
      environment[key] = assignment.slice(separator + 1);
      options.push(item, assignment);
      index += 2;
      continue;
    }
    break;
  }
  const container = validContainer(argv[index], EXEC_CONTAINERS);
  const command = argv.slice(index + 1).map((item) => boundedText(item));
  if (!command.length) deny("A container command is required");
  return { options, environment, container, command };
}

function validateWp(command) {
  let index = 0;
  if (command[0] === "nice") {
    if (command[1] !== "-n" || command[2] !== "10") deny("Invalid WordPress priority");
    index = 3;
  }
  if (command[index] !== "wp" || command[index + 1] !== "--allow-root") deny("Invalid WordPress command");
  const args = command.slice(index + 2);
  if (!WP_COMMANDS.has(args[0])) deny("WordPress command is not allowed");
  for (const argument of args) {
    if (WP_BLOCKED_OPTIONS.some((option) => argument === option || argument.startsWith(`${option}=`))) {
      deny(`WordPress option is not allowed: ${argument}`);
    }
    if (argument.startsWith("--path=")) validSitePath(argument.slice(7));
  }
}

function validateNginx(command) {
  if (command[0] === "nginx" && (
    (command.length === 2 && command[1] === "-t")
    || (command.length === 3 && command[1] === "-s" && command[2] === "reload")
  )) return;
  if (command.join("\0") === ["du", "-sk", "/var/cache/nginx/fastcgi"].join("\0")) return;
  if (command[0] === "wget") {
    const hostIndex = command.indexOf("--header");
    const url = command[command.length - 1];
    const header = command[hostIndex + 1] || "";
    if (
      command[1] === "-q" && command[2] === "--spider" && hostIndex === 3
      && header.startsWith("Host: ") && DOMAIN.test(header.slice(6))
      && /^http:\/\/127\.0\.0\.1(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?\/?$/.test(url)
    ) return;
  }
  deny("Nginx operation is not allowed");
}

function validatePhp(command) {
  if (command.join("\0") === ["php-fpm", "-t"].join("\0")) return;
  if (command[0] === "wp" || command[0] === "nice") {
    validateWp(command);
    return;
  }
  if (command[0] === "php" && command[1] === "-l" && command.length === 3) {
    validSitePath(command[2]);
    return;
  }
  if (command[0] === "rm" && command[1] === "-f" && command.length === 3 && SAFE_TEMP_ZIP.test(command[2])) return;
  if (command[0] === "cgi-fcgi" && command.join("\0") === ["cgi-fcgi", "-bind", "-connect", "127.0.0.1:9000"].join("\0")) return;
  if (command[0] === "sh" && ["-c", "-lc"].includes(command[1])) {
    const script = command[2] || "";
    if (PHP_SHELL_SCRIPTS.has(script)) {
      if (command[3] === "database-inspection" || command[3] === "permissions") validSitePath(command[4]);
      if (command[3] === "package-copy" && !SAFE_TEMP_ZIP.test(command[4])) deny("Package destination is not allowed");
      return;
    }
    if (/^find \/var\/www\/[A-Za-z0-9._/-]+ -type d -exec chmod 775 \{\} \+ && find \/var\/www\/[A-Za-z0-9._/-]+ -type f -exec chmod 664 \{\} \+ && chmod 640 \/var\/www\/[A-Za-z0-9._/-]+\/wp-config\.php$/.test(script)) return;
    if (
      script.startsWith('set -eu; site="$1"; chown -R 33:33 "$site"; find "$site" -type d -exec chmod 775 {} +;')
      && command[3] === "permissions" && command.length === 5
    ) {
      validSitePath(command[4]);
      return;
    }
  }
  if (command[0] === "bash" && command[1] === "-c" && command[3] === "optimize-images") {
    validSitePath(command[4]);
    const script = command[2] || "";
    const required = [
      'uploads="$site/wp-content/uploads"', 'convert "$source" -auto-orient -strip -quality 82',
      'find "$uploads" -type f', 'echo "created=$created skipped=$skipped failed=$failed saved=$saved"',
    ];
    if (required.every((fragment) => script.includes(fragment)) && !/curl|wget|nc |\/dev\/tcp|docker|mount|sudo/.test(script)) return;
  }
  deny("PHP runtime operation is not allowed");
}

function validateMysql(command, environment) {
  if (command[0] !== "sh" || command[1] !== "-c" || !MYSQL_SCRIPTS.has(command[2])) {
    deny("MySQL operation is not allowed");
  }
  for (const value of command.slice(4)) {
    if (value.startsWith("--")) {
      if (![
        "--all-databases", "--events", "--hex-blob", "--quick", "--routines",
        "--single-transaction", "--triggers",
      ].includes(value)) deny("MySQL option is not allowed");
    } else if (!IDENTIFIER.test(value)) {
      deny("MySQL identifier is not allowed");
    }
  }
  for (const [key, value] of Object.entries(environment)) {
    if (!["MIGRATION_SQL", "MYSQL_PERFORMANCE_SQL", "SITE_PROVISION_SQL", "SITE_REMOVAL_SQL"].includes(key)) {
      deny("MySQL environment is not allowed");
    }
    boundedText(value);
  }
}

function validateRedis(command) {
  if (command.join("\0") === ["redis-cli", "--raw", "INFO"].join("\0")) return;
  if (command[0] === "redis-cli" && command[1] === "CONFIG" && command[2] === "SET") {
    if (command[3] === "maxmemory" && /^\d{1,6}mb$/.test(command[4])) return;
    if (command[3] === "maxmemory-policy" && [
      "allkeys-lfu", "allkeys-lru", "allkeys-random", "noeviction",
      "volatile-lfu", "volatile-lru", "volatile-random", "volatile-ttl",
    ].includes(command[4])) return;
  }
  deny("Redis operation is not allowed");
}

function validateNpm(command) {
  if (command.length === 3 && command[0] === "sh" && command[1] === "-c" && command[2] === NPM_BACKUP_READ_SCRIPT) return;
  deny("NPM operation is not allowed");
}

function validateExec(argv) {
  const parsed = parseExec(argv);
  if (parsed.container === "hosting-nginx") validateNginx(parsed.command);
  else if (parsed.container === "hosting-php-fpm") validatePhp(parsed.command);
  else if (parsed.container === "hosting-db") validateMysql(parsed.command, parsed.environment);
  else if (parsed.container === "hosting-redis") validateRedis(parsed.command);
  else if (parsed.container === "hosting-npm") validateNpm(parsed.command);
  else deny("Container operation is not allowed");
  return argv;
}

function validateArgs(input) {
  if (!Array.isArray(input) || !input.length || input.length > 500) deny("Docker arguments are invalid");
  const argv = input.map((item) => boundedText(item));
  if (argv[0] === "exec") return validateExec(argv);
  if (argv[0] === "inspect") {
    const name = argv[argv.length - 1];
    validContainer(name, INSPECT_CONTAINERS);
    const ALLOWED_INSPECT_FORMATS = new Set([
      "{{json .State}}",
      "{{json .State.Status}}",
      "{{json .State.Health}}",
      "{{json .Config.Image}}",
    ]);
    if (argv.length !== 4 || argv[1] !== "--format" || !ALLOWED_INSPECT_FORMATS.has(argv[2])) deny("Inspect operation is not allowed");
    return argv;
  }
  if (argv[0] === "ps") {
    const psFormats = [
      ["ps", "-a", "--filter", "name=hosting-", "--format", "{{.Names}}"],
      ["ps", "-a", "--filter", "name=hosting-", "--format", "{{.Names}}\t{{.Status}}"],
    ];
    if (!psFormats.some(fmt => argv.join("\0") === fmt.join("\0"))) deny("List operation is not allowed");
    return argv;
  }
  if (argv[0] === "stats") {
    if (argv[1] !== "--no-stream" || argv[2] !== "--format" || argv[3] !== "{{json .}}") deny("Stats operation is not allowed");
    argv.slice(4).forEach((name) => validContainer(name, INSPECT_CONTAINERS));
    return argv;
  }
  if (argv[0] === "top") {
    if (argv.length !== 4 || argv[1] !== "hosting-php-fpm" || argv[2] !== "-eo" || argv[3] !== "pid,pcpu,pmem,rss,etime,args") deny("Top operation is not allowed");
    return argv;
  }
  if (argv[0] === "logs") {
    if (argv.length !== 4 || argv[1] !== "--tail" || !/^\d{1,4}$/.test(argv[2]) || Number(argv[2]) > 500) deny("Log operation is not allowed");
    validContainer(argv[3], new Set(["hosting-php-fpm"]));
    return argv;
  }
  deny(`Docker operation is not allowed: ${argv[0]}`);
}

function validateCopy(destination) {
  const match = /^([^:]+):(.+)$/.exec(String(destination || ""));
  if (!match || validContainer(match[1]) !== "hosting-php-fpm" || !SAFE_TEMP_ZIP.test(match[2])) {
    deny("Container copy destination is not allowed");
  }
  return { container: match[1], path: match[2] };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length >= 32 && crypto.timingSafeEqual(a, b);
}

module.exports = { NPM_BACKUP_READ_SCRIPT, safeEqual, validateArgs, validateCopy };
