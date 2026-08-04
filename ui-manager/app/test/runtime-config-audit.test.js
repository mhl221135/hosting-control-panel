const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DEFAULTS, RuntimeConfigAudit, normalizeCategory, redact } = require("../lib/runtime-config-audit");

function makeAudit(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rca-"));
  return { manager: new RuntimeConfigAudit({ dataDir: dir, ...options }), dir };
}

test("records a versioned event with mode-0600 atomic persistence", () => {
  const { manager, dir } = makeAudit();
  const event = manager.record({
    category: "host",
    operator: "ops@example.com",
    mutating: true,
    result: "success",
    verification: "success",
    rollback: "not-required",
    counts: { hostsChanged: 3 },
    scope: ["pool_a", "pool_b"],
  });
  assert.ok(event);
  assert.equal(event.category, "host");
  assert.equal(event.operator, "ops@example.com");
  assert.equal(event.counts.hostsChanged, 3);
  assert.deepEqual(event.scope, ["pool_a", "pool_b"]);
  assert.equal(event.at.includes("T"), true);
  const filePath = manager.filePath;
  const stat = fs.statSync(filePath);
  assert.equal(stat.mode & 0o777, 0o600);
  const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(stored.version, 1);
  assert.equal(stored.history.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("enforces bounded retention and recent limit", () => {
  const { manager, dir } = makeAudit({ maxEvents: 5 });
  for (let index = 0; index < 12; index += 1) {
    manager.record({ category: "pool", result: "success", counts: { poolsChanged: 1 } });
  }
  const stored = JSON.parse(fs.readFileSync(manager.filePath, "utf8")).history;
  assert.equal(stored.length, 5);
  assert.equal(manager.recent(2).length, 2);
  assert.equal(manager.recent(100).length, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tolerates missing and corrupt files", () => {
  const { manager, dir } = makeAudit();
  assert.deepEqual(manager.readHistory(), []);
  fs.writeFileSync(manager.filePath, "{ not json", "utf8");
  assert.deepEqual(manager.readHistory(), []);
  fs.writeFileSync(manager.filePath, JSON.stringify({ version: 99, history: [] }), "utf8");
  assert.deepEqual(manager.readHistory(), []);
  fs.writeFileSync(manager.filePath, JSON.stringify({ history: "bad" }), "utf8");
  assert.deepEqual(manager.readHistory(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("re-sanitizes persisted entries when reading", () => {
  const { manager, dir } = makeAudit();
  manager.record({ category: "pool", result: "success", counts: { poolsChanged: 1 } });
  fs.writeFileSync(manager.filePath, JSON.stringify({
    version: 1,
    history: [
      { version: 1, at: "bad-time", category: "pool", result: "success", counts: { poolsChanged: -5 }, error: "Authorization: Bearer abcDEF12345 token=secret" },
      { category: "nonsense" },
      { at: new Date().toISOString(), category: "opcache", result: "failed", mutating: true, verification: "failed", rollback: "failed", error: "https://user:pass@example.com failed" },
    ],
  }), "utf8");
  const history = manager.readHistory();
  assert.equal(history.length, 2); // nonsense event dropped; invalid-at normalized to now
  const pool = history.find((event) => event.category === "pool");
  assert.deepEqual(pool.counts, {}); // negative counts dropped
  assert.equal(pool.error.includes("Bearer abcDEF12345"), false);
  assert.equal(pool.error.includes("token=secret"), false);
  const event = history.find((item) => item.category === "opcache");
  assert.equal(event.category, "opcache");
  assert.equal(event.error.includes("user:pass"), false);
  assert.equal(event.error.includes("example.com"), false);
  assert.ok(event.at.includes("T"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("unknown categories and secret fields are dropped; counts bounded", () => {
  const { manager, dir } = makeAudit();
  const bad = manager.record({ category: "weird", result: "success" });
  assert.equal(bad, null);
  const event = manager.record({
    category: "host",
    result: "success",
    counts: { hostsChanged: 2, totallyUnknown: 999, hostsRemoved: -3 },
    password: "hunter2",
    token: "tk_secret",
    rawPayload: { config: "full contents" },
  });
  assert.equal("password" in event, false);
  assert.equal("token" in event, false);
  assert.equal("rawPayload" in event, false);
  assert.equal(event.counts.hostsChanged, 2);
  assert.equal(event.counts.totallyUnknown, undefined);
  assert.equal(event.counts.hostsRemoved, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("redacts credential and domain patterns", () => {
  assert.match(redact("token=tk_12345"), /\[redacted\]/);
  assert.match(redact("Authorization: Bearer abcDEF123ghij"), /\[redacted\]/);
  assert.match(redact("password=secret"), /\[redacted\]/);
  assert.match(redact("https://user:pass@example.com/x"), /\[redacted\]/);
  const cleaned = redact("error connecting to production.example.com");
  assert.equal(cleaned.includes("production.example.com"), false);
});

test("normalizeCategory lowercases and validates", () => {
  assert.equal(normalizeCategory("Pool"), "pool");
  assert.equal(normalizeCategory("opcache"), "opcache");
  assert.equal(normalizeCategory("unknown"), "");
  assert.equal(normalizeCategory(""), "");
});

test("audit failures never mask: record tolerates a non-object and returns null", () => {
  const { manager, dir } = makeAudit();
  const result = manager.record("not an object");
  assert.equal(result, null);
  assert.deepEqual(manager.readHistory(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
