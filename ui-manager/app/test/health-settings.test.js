const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DEFAULTS, HealthSettings, validate } = require("../lib/health-settings");

test("persists validated health thresholds and container names", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-health-settings-"));
  try {
    const settings = new HealthSettings(directory);
    assert.deepEqual(settings.read(), DEFAULTS);
    const saved = settings.save({
      enabled: true,
      intervalMinutes: 10,
      diskWarningPercent: 75,
      diskCriticalPercent: 88,
      certificateWarningDays: 45,
      certificateCriticalDays: 10,
      opcacheWarningPercent: 92,
      requiredContainers: "hosting-ui\nhosting-db hosting-ui",
      publicCheckTimeoutSeconds: 8,
      publicHosts: "Example.com\nshop.example.com example.com.",
    });
    assert.deepEqual(saved.requiredContainers, ["hosting-ui", "hosting-db"]);
    assert.deepEqual(saved.publicHosts, ["example.com", "shop.example.com"]);
    assert.deepEqual(settings.read(), saved);
    assert.equal(fs.statSync(settings.path).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects unsafe or contradictory health settings", () => {
  assert.throws(() => validate({ diskWarningPercent: 90, diskCriticalPercent: 80 }), /lower than the critical/);
  assert.throws(() => validate({ certificateWarningDays: 7, certificateCriticalDays: 7 }), /lower than warning/);
  assert.throws(() => validate({ requiredContainers: "hosting-ui;bad/name" }), /unsupported characters/);
  assert.throws(() => validate({ publicHosts: "https://example.com/path" }), /valid hostnames/);
});
