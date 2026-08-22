const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { HaControl } = require("../lib/ha-control");

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-ha-control-"));
  return { dataDir, control: new HaControl({ dataDir, now: () => Date.parse("2026-08-22T12:00:00Z") }) };
}

test("exposes only role-appropriate HA actions", () => {
  const value = fixture();
  try {
    assert.deepEqual(value.control.view("primary", "one").actions, ["replicate-now"]);
    assert.deepEqual(value.control.view("standby", "two").actions, [
      "finalize-standby", "failover-check", "promotion-preview", "promote-standby", "request-witness-fence",
    ]);
    assert.deepEqual(value.control.view("standalone", "three").actions, []);
  } finally { fs.rmSync(value.dataDir, { recursive: true, force: true }); }
});

test("exposes role transitions only for standby or a receipt-backed promoted primary", () => {
  const value = fixture();
  try {
    assert.deepEqual(value.control.view("standby", "two").actions, [
      "finalize-standby", "failover-check", "promotion-preview", "promote-standby", "request-witness-fence",
    ]);
    assert.deepEqual(value.control.view("primary", "one").actions, ["replicate-now"]);
    const promotion = { status: "local-primary", publicIngressCutover: true };
    assert.deepEqual(value.control.view("primary", "one", promotion).actions, [
      "replicate-now", "rebuild-preview", "rebuild-former-primary", "failback-preview", "complete-failback",
    ]);
    assert.equal(value.control.request({ action: "rebuild-preview", confirm: "PREVIEW-REBUILD" },
      "primary", "one", "operator", promotion).action, "rebuild-preview");
  } finally { fs.rmSync(value.dataDir, { recursive: true, force: true }); }
});

test("requires exact confirmation and machine role", () => {
  const value = fixture();
  try {
    assert.throws(() => value.control.request({ action: "replicate-now", confirm: "REPLICATE-NOW" }, "standby", "two"), /not available/);
    assert.throws(() => value.control.request({ action: "failover-check", confirm: "wrong" }, "standby", "two"), /CHECK-FAILOVER/);
    const request = value.control.request({ action: "failover-check", confirm: "CHECK-FAILOVER" }, "standby", "two", "operator@example.test");
    assert.equal(request.action, "failover-check");
    assert.equal(request.serverId, "two");
    assert.equal(fs.statSync(value.control.requestPath).mode & 0o777, 0o600);
    const stored = fs.readFileSync(value.control.requestPath, "utf8");
    assert.doesNotMatch(stored, /operator@example/);
    assert.throws(() => value.control.request({ action: "finalize-standby", confirm: "FINALIZE-STANDBY" }, "standby", "two"), /still pending/);
  } finally { fs.rmSync(value.dataDir, { recursive: true, force: true }); }
});

test("returns bounded processor results without reading arbitrary fields", () => {
  const value = fixture();
  try {
    fs.writeFileSync(value.control.resultPath, JSON.stringify({
      id: "id", action: "replicate-now", status: "succeeded", message: "done", completedAt: "now", secret: "hidden",
    }));
    assert.deepEqual(value.control.view("primary", "one").result, {
      id: "id", action: "replicate-now", status: "succeeded", message: "done", completedAt: "now",
    });
  } finally { fs.rmSync(value.dataDir, { recursive: true, force: true }); }
});
