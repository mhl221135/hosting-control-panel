const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MaintenanceManager } = require("../lib/maintenance-manager");

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-maintenance-test-"));
  const jobs = [];
  const manager = new MaintenanceManager({
    dataDir: root,
    backupManager: { async withLock(job, work) { jobs.push(job); return work(); } },
    runner: options.runner || { async run() { return { ok: true, operations: [] }; } },
    siteProvider: options.siteProvider || (async () => []),
    afterRun: options.afterRun,
    jobManager: options.jobManager,
  });
  return { root, jobs, manager };
}

test("runs websites sequentially, records results, and purges touched caches", async () => {
  const calls = [];
  const purged = [];
  const context = fixture({
    runner: { async run(site, operations) { calls.push([site.host, operations]); return { ok: true, operations: [{ operation: "cron", ok: true }] }; } },
    afterRun: async (domains) => purged.push(...domains),
  });
  try {
    context.manager.start([{ host: "one.example" }, { host: "two.example" }], ["cron"]);
    const status = await context.manager.wait();
    assert.deepEqual(calls.map(([domain]) => domain), ["one.example", "two.example"]);
    assert.deepEqual(purged, ["one.example", "two.example"]);
    assert.equal(context.jobs[0].type, "maintenance");
    assert.equal(status.completed, 2);
    assert.equal(status.running, false);
    assert.match(status.message, /completed$/);
  } finally { fs.rmSync(context.root, { recursive: true, force: true }); }
});

test("queues revision retention in durable payload and deduplication scope", () => {
  const registered = new Map();
  const created = [];
  const context = fixture({
    jobManager: {
      register(type, handler) { registered.set(type, handler); },
      create(input) { created.push(input); return { id: "job-1", ...input }; },
    },
  });
  try {
    const job = context.manager.enqueue(
      [{ host: "one.example", directory: "one.example", redis: false }],
      ["revisions"],
      "operator@example",
      "manual",
      "",
      { revisionRetention: 7 },
    );
    assert.ok(registered.has("wordpress.maintenance"));
    assert.equal(job.payload.revisionRetention, 7);
    assert.match(job.idempotencyKey, /revisions-7$/);
    assert.deepEqual(created[0].payload.operations, ["revisions"]);
  } finally { fs.rmSync(context.root, { recursive: true, force: true }); }
});

test("validates and persists weekly maintenance settings", () => {
  const context = fixture();
  try {
    const initial = context.manager.readSettings();
    assert.equal(initial.enabled, false);
    assert.equal(initial.weekday, 0);
    assert.equal(initial.revisionRetention, 5);
    assert.deepEqual(initial.operations, ["transients", "trash", "cron"]);
    const settings = context.manager.updateSettings({ enabled: true, weekday: 3, scheduleTime: "04:30", operations: ["cron", "revisions"], revisionRetention: 8 });
    assert.equal(settings.scheduleTime, "04:30");
    assert.equal(settings.revisionRetention, 8);
    assert.throws(() => context.manager.updateSettings({ weekday: 7 }), (error) => error.statusCode === 400);
    assert.throws(() => context.manager.updateSettings({ scheduleTime: "29:00" }), (error) => error.statusCode === 400);
    assert.throws(() => context.manager.updateSettings({ revisionRetention: 0 }), (error) => error.statusCode === 400);
  } finally { fs.rmSync(context.root, { recursive: true, force: true }); }
});

test("previews revision cleanup sequentially and isolates site failures", async () => {
  const context = fixture({
    runner: {
      async previewRevisions(site, retention) {
        assert.equal(retention, 6);
        if (site.host === "bad.example") throw new Error("preview failed");
        return { total: 12, delete: 3 };
      },
    },
  });
  try {
    const preview = await context.manager.previewRevisions([
      { host: "good.example" },
      { host: "bad.example" },
    ], 6);
    assert.equal(preview.totalDelete, 3);
    assert.deepEqual(preview.results[0], { domain: "good.example", ok: true, total: 12, delete: 3 });
    assert.equal(preview.results[1].ok, false);
    assert.match(preview.results[1].message, /preview failed/);
  } finally { fs.rmSync(context.root, { recursive: true, force: true }); }
});

test("scheduled maintenance includes only enabled WordPress sites once per day", async () => {
  const called = [];
  const context = fixture({
    runner: { async run(site) { called.push(site.host); return { ok: true, operations: [] }; } },
    siteProvider: async () => [
      { host: "enabled.example", state: { siteType: "wordpress", maintenanceEnabled: true } },
      { host: "disabled.example", state: { siteType: "wordpress", maintenanceEnabled: false } },
      { host: "static.example", state: { siteType: "static", maintenanceEnabled: true } },
    ],
  });
  try {
    context.manager.updateSettings({ enabled: true, weekday: 0, scheduleTime: "05:00", operations: ["cron"] });
    const status = await context.manager.runScheduled(new Date(2026, 6, 26, 5, 15));
    assert.deepEqual(called, ["enabled.example"]);
    assert.equal(status.completed, 1);
    assert.equal(context.manager.readSettings().lastScheduledDate, "2026-07-26");
    assert.equal(await context.manager.runScheduled(new Date(2026, 6, 26, 6, 0)), null);
  } finally { fs.rmSync(context.root, { recursive: true, force: true }); }
});

test("rejects a second run while maintenance is active", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const context = fixture({ runner: { async run() { await pending; return { ok: true, operations: [] }; } } });
  try {
    context.manager.start([{ host: "one.example" }], ["cron"]);
    assert.throws(() => context.manager.start([{ host: "two.example" }], ["cron"]), (error) => error.statusCode === 409);
    finish();
    await context.manager.wait();
  } finally { fs.rmSync(context.root, { recursive: true, force: true }); }
});
