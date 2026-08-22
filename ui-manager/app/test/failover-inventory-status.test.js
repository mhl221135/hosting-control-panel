const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readFailoverInventoryStatus } = require("../lib/failover-inventory-status");

function fixture(candidates, active) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "failover-inventory-"));
  const content = `${candidates.join("\n")}\n`;
  fs.writeFileSync(path.join(directory, "failover-hosts.candidates.txt"), content);
  fs.writeFileSync(path.join(directory, "failover-hosts.auto.txt"), `${active.join("\n")}\n`);
  fs.writeFileSync(path.join(directory, "failover-hosts.candidates.json"), JSON.stringify({
    version: 1,
    recovery_id: "2026-08-22T06-24-29Z",
    count: candidates.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
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
  fs.writeFileSync(path.join(directory, "failover-hosts.candidates.json"), "{}");
  assert.equal(readFailoverInventoryStatus(directory).available, false);
  fs.unlinkSync(path.join(directory, "failover-hosts.candidates.txt"));
  fs.symlinkSync("missing", path.join(directory, "failover-hosts.candidates.txt"));
  assert.equal(readFailoverInventoryStatus(directory).available, false);
});
