const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DEFAULTS, PhpFpmAudit, normalizeRollback, redact } = require("../lib/php-fpm-audit");

function tempAudit(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "php-fpm-audit-"));
  return new PhpFpmAudit({ dataDir: directory, ...options });
}

function auditPath(manager) {
  return manager.filePath;
}

test("profile save produces a successful durable event", () => {
  const manager = tempAudit();
  const event = manager.record({
    operation: "save",
    status: "success",
    result: "ok",
    rollback: "not-required",
    operator: "ops@example.com",
    profiles: ["medium"],
    changedFields: ["max_children", "request_terminate_timeout"],
  });
  assert.ok(event);
  assert.equal(event.operation, "save");
  assert.equal(event.status, "success");
  assert.equal(event.result, "ok");
  assert.equal(event.rollback, "not-required");
  assert.equal(event.mutating, true);
  assert.equal(event.operator, "ops@example.com");
  assert.deepEqual(event.changedFields, ["max_children", "request_terminate_timeout"]);
  const stored = JSON.parse(fs.readFileSync(auditPath(manager), "utf8"));
  assert.equal(stored.version, 1);
  assert.equal(stored.history.length, 1);
  assert.match(stored.history[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test("apply records a successful application event", () => {
  const manager = tempAudit();
  const event = manager.record({
    operation: "apply",
    status: "success",
    result: "applied",
    rollback: "not-required",
    operator: "ops@example.com",
    profiles: ["medium"],
    selectedPools: ["example_com", "shop_com"],
    changedFields: ["pm.max_children", "request_terminate_timeout"],
  });
  assert.equal(event.operation, "apply");
  assert.equal(event.result, "applied");
  assert.equal(event.rollback, "not-required");
  assert.equal(event.mutating, true);
  assert.deepEqual(event.selectedPools, ["example_com", "shop_com"]);
});

test("apply records a failed attempt after execution with rollback succeeded", () => {
  const manager = tempAudit();
  const event = manager.record({
    operation: "apply",
    status: "failed",
    result: "failed",
    rollback: "succeeded",
    operator: "ops@example.com",
    selectedPools: ["example_com"],
    error: "PHP-FPM reload or port verification failed; changes were rolled back. port 9001 did not accept connections",
  });
  assert.equal(event.status, "failed");
  assert.equal(event.rollback, "succeeded");
  assert.match(event.error, /rolled back/);
});

test("apply records a failed attempt with rollback failed", () => {
  const manager = tempAudit();
  const event = manager.record({
    operation: "apply",
    status: "failed",
    result: "failed",
    rollback: "failed",
    operator: "ops@example.com",
    selectedPools: ["example_com"],
    error: "Configuration write failed; rollback validation also failed",
  });
  assert.equal(event.status, "failed");
  assert.equal(event.rollback, "failed");
  assert.match(event.error, /rollback/);
});

test("preview events are non-mutating and still recorded", () => {
  const manager = tempAudit();
  const event = manager.record({
    operation: "preview",
    status: "success",
    result: "ok",
    operator: "ops@example.com",
    affectedPools: ["example_com"],
    profiles: ["medium"],
  });
  assert.equal(event.operation, "preview");
  assert.equal(event.mutating, false);
  assert.deepEqual(event.affectedPools, ["example_com"]);
});

test("sensitive values in error summaries are redacted", () => {
  const manager = tempAudit();
  const event = manager.record({
    operation: "apply",
    status: "failed",
    error: "Authorization: Bearer abcDEF123ghij; password=superSecret123; token=tk_12345; https://user:pass@example.com/api failed",
  });
  assert.doesNotMatch(event.error, /Bearer abcDEF|superSecret123|tk_12345|user:pass/);
  assert.match(event.error, /\[redacted\]/);
});

test("unknown and sensitive keys are not persisted (whitelist)", () => {
  const manager = tempAudit();
  const event = manager.record({
    operation: "save",
    status: "success",
    operator: "ops@example.com",
    password: "superSecret123",
    token: "tk_secret",
    environmentValues: { APP_KEY: "xyz" },
    requestHeaders: { cookie: "sid=abc" },
    configContents: "full file contents",
  });
  const stored = JSON.parse(fs.readFileSync(auditPath(manager), "utf8")).history[0];
  assert.equal("password" in stored, false);
  assert.equal("token" in stored, false);
  assert.equal("environmentValues" in stored, false);
  assert.equal("requestHeaders" in stored, false);
  assert.equal("configContents" in stored, false);
  assert.ok(event);
});

test("retention limit is enforced", () => {
  const manager = tempAudit({ maxEvents: 5 });
  for (let index = 0; index < 12; index += 1) {
    manager.record({ operation: "save", status: "success", operator: `op${index}` });
  }
  const stored = JSON.parse(fs.readFileSync(auditPath(manager), "utf8")).history;
  assert.equal(stored.length, 5);
  assert.equal(stored[0].operator, "op11");
  assert.equal(stored[4].operator, "op7");
});

test("missing audit file returns empty history", () => {
  const manager = tempAudit();
  assert.deepEqual(manager.readHistory(), []);
  assert.deepEqual(manager.recent(), []);
});

test("corrupted audit file is handled safely and can be overwritten", () => {
  const manager = tempAudit();
  fs.writeFileSync(auditPath(manager), "{ not valid json :::", "utf8");
  assert.deepEqual(manager.readHistory(), []);
  assert.deepEqual(manager.recent(), []);
  manager.record({ operation: "save", status: "success", operator: "op" });
  const stored = JSON.parse(fs.readFileSync(auditPath(manager), "utf8"));
  assert.equal(stored.history.length, 1);
});

test("wrong-shape audit state is treated as empty", () => {
  const manager = tempAudit();
  fs.writeFileSync(auditPath(manager), JSON.stringify({ history: "not-an-array" }), "utf8");
  assert.deepEqual(manager.readHistory(), []);
  fs.writeFileSync(auditPath(manager), JSON.stringify({ version: 99, history: [] }), "utf8");
  assert.deepEqual(manager.readHistory(), []);
});

test("atomic persistence leaves a valid file after sequential records", () => {
  const manager = tempAudit();
  for (let index = 0; index < 20; index += 1) {
    manager.record({ operation: "apply", status: "success", operator: `op${index}`, selectedPools: ["a", "b"] });
  }
  const stored = JSON.parse(fs.readFileSync(auditPath(manager), "utf8"));
  assert.equal(stored.history.length, 20);
  assert.ok(stored.history.every((event) => typeof event.at === "string" && event.status === "success"));
});

test("recent returns a bounded list in newest-first order", () => {
  const manager = tempAudit({ maxEvents: 10 });
  for (let index = 0; index < 10; index += 1) {
    manager.record({ operation: "preview", status: "success", operator: `op${index}` });
  }
  assert.equal(manager.recent(100).length, 10);
  assert.equal(manager.recent(3).length, 3);
  assert.equal(manager.recent(0).length, 10);
});

test("bounded lengths are applied to strings and arrays", () => {
  const manager = tempAudit();
  const event = manager.record({
    operation: "apply",
    status: "success",
    operator: "a".repeat(500),
    selectedPools: Array.from({ length: 500 }, (_, index) => `pool_${index}`),
    changedFields: Array.from({ length: 500 }, (_, index) => `field_${index}`),
    error: "e".repeat(5000),
  });
  assert.ok(event.operator.length <= 160);
  assert.ok(event.selectedPools.length <= 100);
  assert.ok(event.changedFields.length <= 32);
  assert.ok(event.error.length <= 300);
});

test("invalid operation types are rejected", () => {
  const manager = tempAudit();
  const result = manager.record({ operation: "delete", status: "success" });
  assert.equal(result, null);
  assert.deepEqual(manager.readHistory(), []);
});

test("unknown rollback values normalize to not-required", () => {
  assert.equal(normalizeRollback("successful"), "not-required");
  assert.equal(normalizeRollback("succeeded"), "succeeded");
});

test("redact strips bearer credentials", () => {
  assert.match(redact("Authorization: Bearer Q2p3xYzzzzzzzzzz"), /\[redacted\]/);
  assert.doesNotMatch(redact("Authorization: Bearer Q2p3xYzzzzzzzzzz"), /Q2p3xY/);
});
