const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readFailoverInventoryStatus } = require("../lib/failover-inventory-status");

function fixture(candidates, active) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "failover-inventory-"));
  fs.writeFileSync(path.join(directory, "failover-inventory.json"), JSON.stringify({
    version: 1,
    available: true,
    recoveryId: "2026-08-22T06-24-29Z",
    candidateCount: candidates.length,
    activeCount: active.length,
    pendingAdditionCount: 1,
    pendingRemovalCount: 1,
    additions: ["b.example.com"],
    removals: ["old.example.com"],
    truncated: false,
  }));
  return directory;
}

test("reports bounded candidate drift without exposing unrelated metadata", () => {
  const result = readFailoverInventoryStatus(fixture(
    ["a.example.com", "b.example.com"], ["a.example.com", "old.example.com"],
  ));
  assert.deepEqual(result, {
    available: true,
    candidateCount: 2,
    activeCount: 2,
    pendingAdditionCount: 1,
    pendingRemovalCount: 1,
    additions: ["b.example.com"],
    removals: ["old.example.com"],
    truncated: false,
    recoveryId: "2026-08-22T06-24-29Z",
  });
});

test("fails closed for mismatched metadata and unsafe files", () => {
  const directory = fixture(["a.example.com"], ["a.example.com"]);
  fs.writeFileSync(path.join(directory, "failover-inventory.json"), "{}");
  assert.equal(readFailoverInventoryStatus(directory).available, false);
  fs.unlinkSync(path.join(directory, "failover-inventory.json"));
  fs.symlinkSync("missing", path.join(directory, "failover-inventory.json"));
  assert.equal(readFailoverInventoryStatus(directory).available, false);
});
