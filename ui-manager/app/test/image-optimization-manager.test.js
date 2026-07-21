const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ImageOptimizationManager } = require("../lib/image-optimization-manager");

function fixture(optimizer, siteProvider) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-images-test-"));
  const jobs = [];
  const manager = new ImageOptimizationManager({
    dataDir: root,
    backupManager: {
      async withLock(job, work) {
        jobs.push(job);
        return work();
      },
    },
    optimizer,
    siteProvider,
  });
  return { root, jobs, manager };
}

test("optimizes primary websites sequentially and records failures", async () => {
  const calls = [];
  const context = fixture(async (directory) => {
    calls.push(directory);
    if (directory === "broken.example") throw new Error("converter failed");
    return { converted: 4, savedBytes: 1024 };
  });
  try {
    context.manager.start([
      { host: "example.com", directory: "example.com" },
      { host: "broken.example", directory: "broken.example" },
    ]);
    const status = await context.manager.wait();

    assert.deepEqual(calls, ["example.com", "broken.example"]);
    assert.equal(context.jobs.length, 1);
    assert.equal(context.jobs[0].type, "images-all");
    assert.equal(status.running, false);
    assert.equal(status.completed, 2);
    assert.equal(status.results[0].converted, 4);
    assert.equal(status.results[1].ok, false);
    assert.match(status.message, /1 failed website/);
    assert.equal(JSON.parse(fs.readFileSync(context.manager.statusPath, "utf8")).completed, 2);
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("validates and persists automatic optimization settings", () => {
  const context = fixture(async () => ({}));
  try {
    assert.deepEqual(context.manager.readSettings(), {
      enabled: false,
      scheduleTime: "04:00",
      lastScheduledDate: "",
    });
    const settings = context.manager.updateSettings({ enabled: true, scheduleTime: "05:30" });
    assert.equal(settings.enabled, true);
    assert.equal(settings.scheduleTime, "05:30");
    assert.throws(
      () => context.manager.updateSettings({ scheduleTime: "25:00" }),
      (error) => error.statusCode === 400,
    );
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("scheduled optimization includes only enabled primary websites", async () => {
  const calls = [];
  const context = fixture(
    async (directory) => {
      calls.push(directory);
      return { created: 1, skipped: 0, failed: 0, bytesSaved: 10 };
    },
    async () => [
      { host: "enabled.example", directory: "enabled.example", state: { imageOptimizationEnabled: true } },
      { host: "disabled.example", directory: "disabled.example", state: { imageOptimizationEnabled: false } },
      { host: "www.enabled.example", directory: "enabled.example", isAlias: true, state: { imageOptimizationEnabled: true } },
    ],
  );
  try {
    context.manager.updateSettings({ enabled: true, scheduleTime: "03:00" });
    const result = await context.manager.runScheduled(new Date(2026, 6, 22, 4, 0));
    assert.deepEqual(calls, ["enabled.example"]);
    assert.equal(result.completed, 1);
    assert.equal(context.manager.readSettings().lastScheduledDate, "2026-07-22");
    assert.equal(await context.manager.runScheduled(new Date(2026, 6, 22, 5, 0)), null);
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("rejects a second bulk optimization while one is active", async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const context = fixture(async () => pending);
  try {
    context.manager.start([{ host: "example.com", directory: "example.com" }]);
    assert.throws(
      () => context.manager.start([{ host: "other.example", directory: "other.example" }]),
      (error) => error.statusCode === 409,
    );
    finish({ converted: 1, savedBytes: 10 });
    await context.manager.wait();
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("marks an interrupted persisted run as stopped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-images-test-"));
  try {
    fs.writeFileSync(
      path.join(root, "image-optimization-status.json"),
      JSON.stringify({ running: true, currentDomain: "example.com", completed: 3, total: 8 }),
    );
    const manager = new ImageOptimizationManager({
      dataDir: root,
      backupManager: { withLock: async () => {} },
      optimizer: async () => ({}),
    });
    assert.equal(manager.getStatus().running, false);
    assert.match(manager.getStatus().message, /interrupted/);
    assert.equal(JSON.parse(fs.readFileSync(manager.statusPath, "utf8")).running, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
