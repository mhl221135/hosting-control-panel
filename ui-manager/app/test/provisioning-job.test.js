const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { JobManager } = require("../lib/job-manager");
const { jobInput, jobResult, safeProvisionPayload } = require("../lib/provisioning-job");

test("provisioning jobs never persist submitted administrator passwords", () => {
  const request = safeProvisionPayload({
    domain: "example.com",
    admin_password: "do-not-persist",
    import_database_dump: false,
    plugin_packages: ["plugin-id"],
    apply_security_preset: true,
    security_preset: "suspicious-probes",
    unknown: "discarded",
  });
  assert.deepEqual(request, {
    domain: "example.com",
    import_database_archive: false,
    plugin_packages: ["plugin-id"],
    apply_security_preset: true,
    security_preset: "suspicious-probes",
  });
  const input = jobInput({ body: request, domain: "example.com", operator: "admin@example.com" });
  assert.equal(JSON.stringify(input).includes("do-not-persist"), false);
  assert.deepEqual(input.conflicts, ["server-heavy", "runtime-config", "site:example.com"]);
  assert.equal(input.retryable, false);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-provision-job-test-"));
  try {
    const manager = new JobManager({ dataDir });
    manager.register("site.provision", async () => ({ ok: true }));
    assert.doesNotThrow(() => manager.create(input));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("maps DNS, NPM, and certificate warnings to partial job results", () => {
  const result = jobResult({
    domain: "example.com",
    imported: false,
    steps: [
      { name: "runtime", status: "complete" },
      { name: "npm", status: "warning", message: "Certificate request failed" },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.match(result.message, /with 1 warning/);
});
