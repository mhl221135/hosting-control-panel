const { execFile } = require("child_process");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const ALLOWED_OPERATIONS = new Set(["transients", "trash", "cron", "database"]);

function validateOperations(values) {
  const operations = [...new Set(Array.isArray(values) ? values.map(String) : [])];
  if (!operations.length || operations.some((operation) => !ALLOWED_OPERATIONS.has(operation))) {
    const error = new Error("Select at least one valid maintenance operation");
    error.statusCode = 400;
    throw error;
  }
  return operations;
}

function wordpressPath(directory) {
  if (!String(directory || "").trim()) throw new Error("Invalid WordPress directory");
  const normalized = path.posix.normalize(`/var/www/${String(directory || "")}`);
  if (!normalized.startsWith("/var/www/") || normalized.replace(/\/$/, "") === "/var/www") {
    throw new Error("Invalid WordPress directory");
  }
  return normalized;
}

class WordPressMaintenanceRunner {
  constructor(options = {}) {
    this.phpContainer = options.phpContainer || "hosting-php-fpm";
    this.execFile = options.execFile || execFileAsync;
  }

  async wp(directory, args, timeout = 15 * 60_000) {
    const sitePath = wordpressPath(directory);
    const result = await this.execFile("docker", [
      "exec", "-u", "33:33", this.phpContainer,
      "nice", "-n", "10", "wp", "--allow-root", ...args, `--path=${sitePath}`,
    ], { timeout, maxBuffer: 4 * 1024 * 1024 });
    return String(result.stdout || "").trim();
  }

  async ids(directory, args) {
    const output = await this.wp(directory, [...args, "--format=ids", "--quiet"]);
    return output.split(/\s+/).filter((value) => /^\d+$/.test(value));
  }

  async deleteIds(directory, command, ids) {
    for (let offset = 0; offset < ids.length; offset += 100) {
      await this.wp(directory, [command, "delete", ...ids.slice(offset, offset + 100), "--force"]);
    }
  }

  async runOperation(site, operation) {
    if (operation === "transients") {
      return { message: await this.wp(site.directory, ["transient", "delete", "--expired", "--skip-plugins", "--skip-themes"]) };
    }
    if (operation === "trash") {
      const posts = await this.ids(site.directory, ["post", "list", "--post_status=trash", "--post_type=any"]);
      const spamComments = await this.ids(site.directory, ["comment", "list", "--status=spam"]);
      const trashComments = await this.ids(site.directory, ["comment", "list", "--status=trash"]);
      await this.deleteIds(site.directory, "post", posts);
      await this.deleteIds(site.directory, "comment", [...spamComments, ...trashComments]);
      return { postsDeleted: posts.length, commentsDeleted: spamComments.length + trashComments.length };
    }
    if (operation === "cron") {
      return { message: await this.wp(site.directory, ["cron", "event", "run", "--due-now"]) };
    }
    const optimizeTables = [
      "global $wpdb;",
      "$tables = $wpdb->get_col($wpdb->prepare(\"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s AND TABLE_TYPE = 'BASE TABLE'\", DB_NAME));",
      "$failures = [];",
      "foreach ($tables as $table) {",
      "  $safe = str_replace(\"`\", \"``\", $table);",
      "  $rows = $wpdb->get_results(\"OPTIMIZE TABLE `\" . $safe . \"`\");",
      "  if ($rows === null) { $failures[] = $table . \": \" . ($wpdb->last_error ?: \"query failed\"); continue; }",
      "  foreach ($rows as $row) {",
      "    $type = strtolower((string) ($row->Msg_type ?? \"\"));",
      "    $text = (string) ($row->Msg_text ?? \"\");",
      "    if ($type === \"error\" || stripos($text, \"operation failed\") !== false) $failures[] = $table . \": \" . $text;",
      "  }",
      "}",
      "if ($failures) WP_CLI::error(\"Some tables could not be optimized: \" . implode(\"; \", array_slice($failures, 0, 3)) . (count($failures) > 3 ? \"; and \" . (count($failures) - 3) . \" more\" : \"\"));",
      "WP_CLI::success(\"Optimized \" . count($tables) . \" database tables.\");",
    ].join("\n");
    return { message: await this.wp(site.directory, ["eval", optimizeTables, "--skip-plugins", "--skip-themes"], 30 * 60_000) };
  }

  async run(site, requestedOperations) {
    const operations = validateOperations(requestedOperations);
    const results = [];
    for (const operation of operations) {
      try {
        results.push({ operation, ok: true, ...(await this.runOperation(site, operation)) });
      } catch (error) {
        results.push({ operation, ok: false, message: String(error.stderr || error.message) });
      }
    }
    if (site.redis) {
      try {
        results.push({ operation: "redis", ok: true, message: await this.wp(site.directory, ["cache", "flush"]) });
      } catch (error) {
        results.push({ operation: "redis", ok: false, message: String(error.stderr || error.message) });
      }
    }
    return { ok: results.every((result) => result.ok), operations: results };
  }
}

module.exports = { ALLOWED_OPERATIONS, WordPressMaintenanceRunner, validateOperations, wordpressPath };
