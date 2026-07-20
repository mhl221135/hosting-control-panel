const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout || 180_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.details = `${stdout}\n${stderr}`.trim();
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function validateDomain(domain) {
  const value = String(domain || "").trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) {
    const error = new Error("Enter a valid domain");
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function safeSiteDirectory(websitesRoot, requested) {
  const directory = String(requested || "").trim();
  if (!directory || directory.includes("/") || directory.includes("\\") || directory === "." || directory === "..") {
    const error = new Error("Website directory must be one folder name");
    error.statusCode = 400;
    throw error;
  }
  const root = path.resolve(websitesRoot);
  const target = path.resolve(root, directory);
  if (path.dirname(target) !== root) {
    const error = new Error("Website directory is outside the allowed root");
    error.statusCode = 400;
    throw error;
  }
  return target;
}

function mysqlIdentifier(domain, prefix = "yogali00_") {
  const normalizedPrefix = String(prefix || "yogali00_").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 16);
  const domainPart = validateDomain(domain).replace(/[^a-z0-9]/g, "_");
  const full = `${normalizedPrefix}${domainPart}`;
  if (full.length <= 32) return full;
  const hash = crypto.createHash("sha256").update(full).digest("hex").slice(0, 7);
  return `${full.slice(0, 24)}_${hash}`;
}

function randomPassword(length = 32) {
  return crypto.randomBytes(Math.ceil((length * 3) / 4)).toString("base64url").slice(0, length);
}

async function createDatabase(domain, config = {}) {
  const container = String(config.mysqlContainer || process.env.MYSQL_CONTAINER || "hosting-db");
  if (!/^[a-zA-Z0-9_.-]+$/.test(container)) {
    const error = new Error("MySQL container name is invalid");
    error.statusCode = 400;
    throw error;
  }
  const name = mysqlIdentifier(domain, config.mysqlSitePrefix || process.env.MYSQL_SITE_PREFIX || "yogali00_");
  const password = randomPassword();
  const sql = [
    `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE USER IF NOT EXISTS '${name}'@'%' IDENTIFIED BY '${password}'`,
    `ALTER USER '${name}'@'%' IDENTIFIED BY '${password}'`,
    `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${name}'@'%'`,
    "FLUSH PRIVILEGES",
  ].join("; ");
  await execFileAsync("docker", [
    "exec",
    "-e",
    `SITE_PROVISION_SQL=${sql}`,
    container,
    "sh",
    "-c",
    'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "$SITE_PROVISION_SQL"',
  ]);
  return { name, user: name, password };
}

async function runWp(args, timeout = 180_000) {
  return execFileAsync(
    "docker",
    ["exec", "-u", "33:33", "hosting-php-fpm", "wp", "--allow-root", ...args],
    { timeout },
  );
}

function wordpressContainerPath(directory) {
  const relative = path.posix.normalize(String(directory || "").trim().replace(/^\/+/, ""));
  if (!relative || relative === "." || relative === ".." || relative.startsWith("../")) {
    const error = new Error("Website path is outside the allowed root");
    error.statusCode = 400;
    throw error;
  }
  return `/var/www/${relative}`;
}

async function normalizeWordPressPermissions(directory) {
  const containerPath = wordpressContainerPath(directory);
  await execFileAsync("docker", [
    "exec",
    "hosting-php-fpm",
    "sh",
    "-c",
    [
      'set -eu; site="$1"',
      'chown -R 33:33 "$site"',
      'find "$site" -type d -exec chmod 775 {} +',
      'find "$site" -type f -exec chmod 664 {} +',
      'if [ -f "$site/wp-config.php" ]; then chmod 660 "$site/wp-config.php"; fi',
    ].join("; "),
    "permissions",
    containerPath,
  ], { timeout: 30 * 60 * 1000 });
  return containerPath;
}

async function installWordPress(options) {
  const domain = validateDomain(options.domain);
  const containerPath = `/var/www/${options.directory}`;
  const database = options.database;
  await runWp(["core", "download", `--path=${containerPath}`, "--force"]);
  await runWp([
    "config",
    "create",
    `--path=${containerPath}`,
    `--dbname=${database.name}`,
    `--dbuser=${database.user}`,
    `--dbpass=${database.password}`,
    "--dbhost=hosting-db",
    "--dbcharset=utf8mb4",
    "--skip-check",
    "--force",
  ]);
  await runWp([
    "core",
    "install",
    `--path=${containerPath}`,
    `--url=${options.useHttps ? `https://${domain}` : `http://${domain}`}`,
    `--title=${options.title || domain}`,
    `--admin_user=${options.adminUser}`,
    `--admin_password=${options.adminPassword}`,
    `--admin_email=${options.adminEmail}`,
    "--skip-email",
  ]);
  await runWp(["rewrite", "structure", "/%postname%/", `--path=${containerPath}`, "--hard"]);

  if (options.redis) {
    await runWp(["config", "set", "WP_REDIS_HOST", "hosting-redis", "--type=constant", `--path=${containerPath}`]);
    await runWp(["config", "set", "WP_REDIS_PREFIX", `${domain}:`, "--type=constant", `--path=${containerPath}`]);
    await runWp(["plugin", "install", "redis-cache", "--activate", `--path=${containerPath}`]);
    await runWp(["redis", "enable", `--path=${containerPath}`]);
  }

  await execFileAsync("docker", [
    "exec",
    "hosting-php-fpm",
    "sh",
    "-lc",
    `find ${containerPath} -type d -exec chmod 775 {} + && find ${containerPath} -type f -exec chmod 664 {} + && chmod 640 ${containerPath}/wp-config.php`,
  ]);
}

async function updateWordPressUrl(directory, domain, useHttps) {
  const containerPath = `/var/www/${directory}`;
  const url = `${useHttps ? "https" : "http"}://${validateDomain(domain)}`;
  await runWp(["option", "update", "home", url, `--path=${containerPath}`]);
  await runWp(["option", "update", "siteurl", url, `--path=${containerPath}`]);
}

async function setRedis(directory, domain, enabled) {
  const containerPath = await normalizeWordPressPermissions(directory);
  validateDomain(domain);
  if (enabled) {
    await runWp(["config", "set", "WP_REDIS_HOST", "hosting-redis", "--type=constant", `--path=${containerPath}`]);
    await runWp(["config", "set", "WP_REDIS_PREFIX", `${domain}:`, "--type=constant", `--path=${containerPath}`]);
    await runWp(["plugin", "install", "redis-cache", "--activate", `--path=${containerPath}`]);
    await runWp(["redis", "enable", `--path=${containerPath}`]);
    return;
  }
  await runWp(["redis", "disable", `--path=${containerPath}`]).catch(() => {});
  await runWp(["plugin", "deactivate", "redis-cache", `--path=${containerPath}`]).catch(() => {});
}

async function optimizeImages(directory) {
  const containerPath = await normalizeWordPressPermissions(directory);
  const script = [
    'set -u; site="$1"; uploads="$site/wp-content/uploads"',
    'if [ ! -d "$uploads" ]; then echo "created=0 skipped=0 failed=0 saved=0"; exit 0; fi',
    "created=0; skipped=0; failed=0; saved=0",
    'while IFS= read -r -d "" source; do',
    '  target="$source.webp"',
    '  if [ -f "$target" ] && [ "$target" -nt "$source" ]; then skipped=$((skipped + 1)); continue; fi',
    '  temporary="$target.tmp.webp"',
    '  if nice -n 10 convert "$source" -auto-orient -strip -quality 82 "$temporary" 2>/dev/null; then',
    '    source_size=$(stat -c %s "$source"); target_size=$(stat -c %s "$temporary")',
    '    if [ "$target_size" -lt "$source_size" ]; then',
    '      mv -f "$temporary" "$target"; chmod 664 "$target"; created=$((created + 1)); saved=$((saved + source_size - target_size))',
    '    else rm -f "$temporary"; skipped=$((skipped + 1)); fi',
    '  else rm -f "$temporary"; failed=$((failed + 1)); fi',
    'done < <(find "$uploads" -type f \\( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \\) -print0)',
    'echo "created=$created skipped=$skipped failed=$failed saved=$saved"',
  ].join("\n");
  const result = await execFileAsync("docker", [
    "exec",
    "hosting-php-fpm",
    "bash",
    "-c",
    script,
    "optimize-images",
    containerPath,
  ], { timeout: 4 * 60 * 60 * 1000 });
  const values = Object.fromEntries(
    result.stdout.trim().split(/\s+/).map((entry) => {
      const [key, value] = entry.split("=");
      return [key, Number(value || 0)];
    }),
  );
  return {
    created: values.created || 0,
    skipped: values.skipped || 0,
    failed: values.failed || 0,
    bytesSaved: values.saved || 0,
  };
}

function prepareSiteDirectory(websitesRoot, directory) {
  const target = safeSiteDirectory(websitesRoot, directory);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    const error = new Error(`Website directory '${directory}' is not empty`);
    error.statusCode = 409;
    throw error;
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o775 });
  fs.chownSync(target, 33, 33);
  return target;
}

module.exports = {
  createDatabase,
  installWordPress,
  mysqlIdentifier,
  normalizeWordPressPermissions,
  optimizeImages,
  prepareSiteDirectory,
  randomPassword,
  safeSiteDirectory,
  setRedis,
  updateWordPressUrl,
  validateDomain,
};
