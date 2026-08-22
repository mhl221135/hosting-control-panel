const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readAutomaticFailoverStatus } = require("../lib/automatic-failover-status");

function fixture(value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-failover-"));
  if (value !== undefined) fs.writeFileSync(path.join(directory, "automatic-failover-state.json"), value);
  return directory;
}

test("returns a bounded automatic failover status", () => {
  const directory = fixture(JSON.stringify({
    version: 1,
    checkedAt: "2026-08-21T20:00:00Z",
    status: "awaiting-fence",
    failures: 8,
    threshold: 6,
    recoveryId: "2026-08-21T19-55-00Z",
    fencePolicy: "unreachable",
    unreachableSince: "2026-08-21T19:50:00Z",
    recoveryAgeSeconds: 1800,
    secret: "must-not-return",
  }));
  assert.deepEqual(readAutomaticFailoverStatus(directory), {
    available: true,
    checkedAt: "2026-08-21T20:00:00Z",
    status: "awaiting-fence",
    failures: 8,
    threshold: 6,
    recoveryId: "2026-08-21T19-55-00Z",
    fencePolicy: "unreachable",
    unreachableSince: "2026-08-21T19:50:00Z",
    recoveryAgeSeconds: 1800,
  });
});

test("fails closed for missing, malformed, oversized, or symlinked state", () => {
  assert.equal(readAutomaticFailoverStatus(fixture()).available, false);
  assert.equal(readAutomaticFailoverStatus(fixture("not-json")).available, false);
  assert.equal(readAutomaticFailoverStatus(fixture("x".repeat(4097))).available, false);
  const directory = fixture();
  fs.symlinkSync("missing", path.join(directory, "automatic-failover-state.json"));
  assert.equal(readAutomaticFailoverStatus(directory).available, false);
});
