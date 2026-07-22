const assert = require("node:assert/strict");
const test = require("node:test");
const { WordPressMaintenanceRunner, databaseOptimizeFailures, validateOperations, wordpressPath } = require("../lib/wordpress-maintenance");

test("validates operations and confines WordPress paths", () => {
  assert.deepEqual(validateOperations(["cron", "cron", "transients"]), ["cron", "transients"]);
  assert.throws(() => validateOperations([]), (error) => error.statusCode === 400);
  assert.throws(() => validateOperations(["core-update"]), (error) => error.statusCode === 400);
  assert.equal(wordpressPath("example.com"), "/var/www/example.com");
  assert.throws(() => wordpressPath("../../etc"), /Invalid WordPress directory/);
  assert.throws(() => wordpressPath(""), /Invalid WordPress directory/);
});

test("extracts mysqlcheck table failures despite WP-CLI success output", () => {
  assert.deepEqual(databaseOptimizeFailures(`
example.wp_posts
note     : Table does not support optimize, doing recreate + analyze instead
error    : Invalid default value for 'post_date'
status   : Operation failed
example.wp_options
status   : OK
  `), ["example.wp_posts: Invalid default value for 'post_date'"]);
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
  const databaseCall = calls.find((call) => call.args.includes("db"));
  assert.ok(databaseCall);
  assert.ok(databaseCall.args.includes("optimize"));
  assert.ok(databaseCall.args.includes("--skip-ssl"));
  assert.ok(calls.some((call) => call.args.includes("flush")));
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

test("marks partial database optimization errors as a failed operation", async () => {
  const runner = new WordPressMaintenanceRunner({
    execFile: async () => ({ stdout: "example.wp_posts\nerror : Invalid default value for 'post_date'\nstatus : Operation failed\nSuccess: Database optimized." }),
  });
  const result = await runner.run({ directory: "example.com", redis: false }, ["database"]);
  assert.equal(result.ok, false);
  assert.match(result.operations[0].message, /example\.wp_posts/);
});
