const assert = require("node:assert/strict");
const test = require("node:test");
const { WordPressMaintenanceRunner, validateOperations, validateRevisionRetention, wordpressPath } = require("../lib/wordpress-maintenance");

test("validates operations and confines WordPress paths", () => {
  assert.deepEqual(validateOperations(["cron", "cron", "transients"]), ["cron", "transients"]);
  assert.throws(() => validateOperations([]), (error) => error.statusCode === 400);
  assert.throws(() => validateOperations(["core-update"]), (error) => error.statusCode === 400);
  assert.equal(validateRevisionRetention(undefined), 5);
  assert.equal(validateRevisionRetention(20), 20);
  assert.throws(() => validateRevisionRetention(0), (error) => error.statusCode === 400);
  assert.throws(() => validateRevisionRetention(101), (error) => error.statusCode === 400);
  assert.equal(wordpressPath("example.com"), "/var/www/example.com");
  assert.throws(() => wordpressPath("../../etc"), /Invalid WordPress directory/);
  assert.throws(() => wordpressPath(""), /Invalid WordPress directory/);
});

test("previews and deletes only revisions outside validated per-post retention", async () => {
  const calls = [];
  const runner = new WordPressMaintenanceRunner({
    execFile: async (_file, args) => {
      calls.push(args);
      return { stdout: args.some((arg) => arg.includes("wp_delete_post"))
        ? '{"total":14,"delete":4,"deleted":4}\n'
        : 'notice\n{"total":14,"delete":4}\n' };
    },
  });

  assert.deepEqual(await runner.previewRevisions({ directory: "example.com" }, 5), { total: 14, delete: 4 });
  const result = await runner.run({ directory: "example.com", redis: false }, ["revisions"], { revisionRetention: 5 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.operations[0], { operation: "revisions", ok: true, total: 14, delete: 4, deleted: 4 });
  assert.ok(calls.every((args) => args.includes("--skip-plugins") && args.includes("--skip-themes")));
  assert.ok(calls.every((args) => args.some((arg) => arg.includes("$keep = 5"))));
});

test("runs selected maintenance commands without shell interpolation", async () => {
  const calls = [];
  const runner = new WordPressMaintenanceRunner({
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "complete\n" };
    },
  });
  const result = await runner.run(
    { directory: "example.com", redis: true },
    ["transients", "cron", "database"],
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.file === "docker"));
  assert.ok(calls.every((call) => call.args.includes("--path=/var/www/example.com")));
  assert.deepEqual(calls[0].args.slice(0, 9), ["exec", "-u", "33:33", "hosting-php-fpm", "nice", "-n", "10", "wp", "--allow-root"]);
  const databaseCall = calls.find((call) => call.args.includes("eval"));
  assert.ok(databaseCall);
  assert.ok(databaseCall.args.some((arg) => arg.includes("OPTIMIZE TABLE")));
  assert.ok(databaseCall.args.some((arg) => arg.includes("WP_CLI::error")));
  assert.ok(calls.some((call) => call.args.includes("flush")));
});

test("collects bounded WordPress core, plugin, and theme versions without mutation", async () => {
  const calls = [];
  const runner = new WordPressMaintenanceRunner({
    execFile: async (_file, args) => {
      calls.push(args);
      if (args.includes("check-update")) {
        return { stdout: JSON.stringify([{ version: "6.8.3", update_type: "minor" }]) };
      }
      if (args.includes("core")) return { stdout: "6.8.2\n" };
      if (args.includes("plugin")) {
        return { stdout: JSON.stringify([{
          name: "woocommerce",
          status: "active",
          version: "9.9.0",
          update: "available",
          update_version: "9.9.1",
          auto_update: "off",
        }]) };
      }
      return { stdout: JSON.stringify([{
        name: "storefront",
        status: "active",
        version: "4.6.0",
        update: "none",
        update_version: "",
        auto_update: "off",
      }]) };
    },
  });

  const inventory = await runner.inventory({ directory: "example.com" });
  assert.equal(inventory.core, "6.8.2");
  assert.deepEqual(inventory.coreUpdate, { available: true, version: "6.8.3", type: "minor" });
  assert.deepEqual(inventory.plugins[0], {
    name: "woocommerce",
    status: "active",
    version: "9.9.0",
    update: "available",
    updateVersion: "9.9.1",
    autoUpdate: "off",
  });
  assert.equal(inventory.themes[0].name, "storefront");
  assert.equal(calls.length, 4);
  assert.ok(calls.every((args) => args.includes("--skip-plugins") && args.includes("--skip-themes")));
  assert.equal(calls.some((args) => args.includes("core") && args.includes("update")), false);
});

test("uses allowlisted update commands and stages uploaded packages safely", async () => {
  const calls = [];
  const runner = new WordPressMaintenanceRunner({
    execFile: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "complete\n" };
    },
  });
  const site = { directory: "example.com" };
  await runner.setMaintenanceMode(site, true);
  await runner.updateCore(site);
  await runner.updatePackages(site, "plugin", ["woocommerce"]);
  await runner.installUploadedPackage(site, {
    kind: "themes",
    path: "/app/data/wordpress-packages/themes/package-id.zip",
  });
  await runner.validateWordPress(site);

  assert.ok(calls.some((call) => call.args.includes("maintenance-mode") && call.args.includes("activate")));
  assert.ok(calls.some((call) => call.args.includes("core") && call.args.includes("update")));
  assert.ok(calls.some((call) => call.args.includes("core") && call.args.includes("update-db")));
  assert.ok(calls.some((call) => call.args.includes("plugin") && call.args.includes("woocommerce")));
  assert.ok(calls.some((call) => call.args[0] === "cp"
    && call.args[1] === "/app/data/wordpress-packages/themes/package-id.zip"));
  assert.ok(calls.some((call) => call.args.includes("theme") && call.args.includes("install")));
  const healthCall = calls.find((call) =>
    call.args.includes("eval") && call.args.some((arg) => arg.includes("$wpdb->get_var('SELECT 1')")));
  assert.ok(healthCall);
  assert.equal(healthCall.args.filter((argument) => argument === "eval").length, 1);
});

test("deletes trash in bounded batches and keeps operation failures isolated", async () => {
  const calls = [];
  const runner = new WordPressMaintenanceRunner({
    execFile: async (_file, args) => {
      calls.push(args);
      if (args.includes("list") && args.includes("post")) return { stdout: Array.from({ length: 105 }, (_, index) => index + 1).join(" ") };
      if (args.includes("list") && args.includes("--status=spam")) return { stdout: "201 202" };
      if (args.includes("list") && args.includes("--status=trash") && args.includes("comment")) return { stdout: "203" };
      if (args.includes("event")) throw Object.assign(new Error("cron failed"), { stderr: "cron failed" });
      return { stdout: "" };
    },
  });
  const result = await runner.run({ directory: "example.com", redis: false }, ["trash", "cron"]);

  assert.equal(result.ok, false);
  assert.equal(result.operations[0].postsDeleted, 105);
  assert.equal(result.operations[0].commentsDeleted, 3);
  assert.equal(calls.filter((args) => args.includes("delete") && args.includes("post")).length, 2);
  assert.equal(calls.filter((args) => args.includes("delete") && args.includes("comment")).length, 1);
  assert.match(result.operations[1].message, /cron failed/);
});
