const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ImageOptimizationManager } = require("../lib/image-optimization-manager");
const { MaintenanceManager } = require("../lib/maintenance-manager");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("image-optimization settings persist atomically and validate the schedule", () => {
  const dir = tmpDir("img-");
  try {
    const manager = new ImageOptimizationManager({ dataDir: dir, backupManager: { status: () => null }, optimizer: null, siteProvider: () => [] });
    manager.updateSettings({ enabled: true, scheduleTime: "06:30" });
    assert.ok(fs.existsSync(path.join(dir, "image-optimization-settings.json")));
    assert.equal(manager.readSettings().scheduleTime, "06:30");
    assert.equal(fs.statSync(path.join(dir, "image-optimization-settings.json")).mode & 0o777, 0o600);
    assert.throws(() => manager.updateSettings({ scheduleTime: "25:00" }), /HH:MM/);
    assert.throws(() => manager.updateSettings({ scheduleTime: "6:30" }), /HH:MM/);
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maintenance settings persist atomically and validate weekday and schedule", async () => {
  const dir = tmpDir("maint-");
  try {
    const manager = new MaintenanceManager({ dataDir: dir, backupManager: { status: () => null }, runner: { run: async () => ({}), updateOrder: () => [] }, siteProvider: () => [] });
    manager.updateSettings({ enabled: true, weekday: 3, scheduleTime: "02:00", operations: ["transients", "trash"], revisionRetention: 7 });
    assert.equal(manager.readSettings().weekday, 3);
    assert.deepEqual(manager.readSettings().operations, ["transients", "trash"]);
    assert.equal(fs.statSync(path.join(dir, "maintenance-settings.json")).mode & 0o777, 0o600);
    assert.throws(() => manager.updateSettings({ weekday: 7 }), /weekday/);
    assert.throws(() => manager.updateSettings({ scheduleTime: "nope" }), /HH:MM/);
    assert.throws(() => manager.updateSettings({ revisionRetention: 0 }), /Revision retention/);
    assert.throws(() => manager.updateSettings({ operations: ["bogus"] }), /maintenance operation/);
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
