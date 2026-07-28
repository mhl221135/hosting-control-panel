const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BillingEntitlementObserver, validatePayload } = require("../lib/billing-entitlement-observer");

const TOKEN = "b".repeat(64);
const NOW = Date.parse("2026-07-28T10:00:00.000Z");

function signed(overrides = {}) {
  const payload = {
    version: 1,
    generatedAt: "2026-07-28T09:59:30.000Z",
    services: [{
      serviceId: "svc_1234567890abcdef12345678",
      primaryDomain: "example.com",
      aliases: ["www.example.com"],
      state: "grace",
      paidThrough: "2026-07-25",
      graceDays: 7,
      enforcementMode: "manual",
    }],
    ...overrides,
  };
  return {
    ...payload,
    signature: crypto.createHmac("sha256", TOKEN).update(JSON.stringify(payload)).digest("base64url"),
  };
}

test("verifies the exact signed entitlement payload and freshness", () => {
  const result = validatePayload(signed(), TOKEN, 300, NOW);
  assert.equal(result.payload.services[0].primaryDomain, "example.com");
  assert.equal(result.ageSeconds, 30);
  assert.throws(() => validatePayload({ ...signed(), signature: "x".repeat(43) }, TOKEN, 300, NOW), /verification failed/);
  assert.throws(
    () => validatePayload(signed({ generatedAt: "2026-07-28T09:50:00.000Z" }), TOKEN, 300, NOW),
    /snapshot is stale/,
  );
});

test("stores only a verified last-known-good dry-run snapshot", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "billing-observer-"));
  let responseDocument = signed();
  const observer = new BillingEntitlementObserver({
    dataDir: directory,
    apiUrl: "http://hosting-billing:8787/internal/v1",
    token: TOKEN,
    now: () => NOW,
    siteProvider: async () => [
      { host: "example.com", isAlias: false },
      { host: "other.example.com", isAlias: false },
      { host: "www.example.com", isAlias: true },
    ],
    fetch: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      return { ok: true, json: async () => responseDocument };
    },
  });
  try {
    const refreshed = await observer.refresh();
    assert.equal(refreshed.mode, "observe-only");
    assert.equal(refreshed.enforcementEnabled, false);
    assert.equal(refreshed.snapshot.matches[0].action, "none");
    assert.deepEqual(refreshed.snapshot.unmatchedLocal, ["other.example.com"]);
    const previous = fs.readFileSync(observer.snapshotPath, "utf8");
    const stored = JSON.parse(previous);
    const storedExpected = crypto.createHmac("sha256", TOKEN)
      .update(JSON.stringify(stored.payload))
      .digest("base64url");
    assert.equal(stored.signature, storedExpected);

    responseDocument = { ...signed(), signature: "x".repeat(43) };
    await assert.rejects(observer.refresh(), /verification failed/);
    assert.equal(fs.readFileSync(observer.snapshotPath, "utf8"), previous);
    assert.match((await observer.view()).lastError, /verification failed/);
  } finally {
    observer.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("observer schedule is disabled by default and validates bounds", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "billing-observer-settings-"));
  try {
    const observer = new BillingEntitlementObserver({ dataDir: directory, apiUrl: "", token: "" });
    assert.equal(observer.readSettings().enabled, false);
    assert.throws(() => observer.saveSettings({ enabled: true, intervalMinutes: 0 }), /intervalMinutes/);
    const saved = observer.saveSettings({ enabled: true, intervalMinutes: 10, maxSnapshotAgeSeconds: 600 });
    assert.deepEqual(saved, { enabled: true, intervalMinutes: 10, maxSnapshotAgeSeconds: 600 });
    assert.equal(fs.statSync(observer.settingsPath).mode & 0o777, 0o600);
    observer.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
