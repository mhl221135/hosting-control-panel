const assert = require("node:assert/strict");
const test = require("node:test");
const { jobInput, parseSelection, validateSelection } = require("../lib/site-removal-job");

test("parses a confirmed removal into a non-retryable site job", () => {
  const selected = parseSelection("example.com", {
    confirm_domain: "EXAMPLE.COM",
    final_backup: true,
    runtime: true,
    pool: true,
    files: true,
  });
  const job = jobInput("example.com", selected, "owner@example.com");
  assert.equal(job.type, "site.remove");
  assert.equal(job.retryable, false);
  assert.equal(job.cancellable, true);
  assert.deepEqual(job.conflicts, ["server-heavy", "runtime-config", "site:example.com"]);
  assert.equal(job.total, 4);
  assert.equal(job.payload.selected.files, true);
  assert.equal("confirm_domain" in job.payload, false);
});

test("rejects unsafe removal selections before queueing", () => {
  assert.throws(() => parseSelection("example.com", { confirm_domain: "wrong.com", files: true }), /Type example.com/);
  assert.throws(() => validateSelection({ finalBackup: true, backups: true }), /cannot be created and deleted/);
  assert.throws(() => validateSelection({ pool: true, runtime: false }), /runtime host records/);
  assert.throws(() => validateSelection({}), /Select at least one/);
});
