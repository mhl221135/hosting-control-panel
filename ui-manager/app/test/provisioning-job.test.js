const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { JobManager } = require("../lib/job-manager");
const {
  jobInput, jobResult, safeProvisionPayload, validateSecondAdministrator,
} = require("../lib/provisioning-job");

test("provisioning jobs never persist submitted administrator passwords", () => {
  const request = safeProvisionPayload({
    domain: "example.com",
    admin_password: "do-not-persist",
    add_second_admin: true,
    second_admin_user: "editor2",
    second_admin_email: "editor2@example.com",
    second_admin_password: "second-do-not-persist",
    import_database_dump: false,
    plugin_packages: ["plugin-id"],
    apply_security_preset: true,
    security_preset: "suspicious-probes",
    register_billing: true,
    billing_grant_free_period: true,
    billing_hosting_price: "80.00",
    billing_contact_email: "owner@example.com",
    unknown: "discarded",
  });
  assert.deepEqual(request, {
    domain: "example.com",
    add_second_admin: true,
    second_admin_user: "editor2",
    second_admin_email: "editor2@example.com",
    import_database_archive: false,
    plugin_packages: ["plugin-id"],
    apply_security_preset: true,
    security_preset: "suspicious-probes",
    register_billing: true,
    billing_grant_free_period: true,
    billing_hosting_price: "80.00",
    billing_contact_email: "owner@example.com",
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

test("second WordPress administrator must have valid, distinct credentials", () => {
  const primary = { primaryEmail: "owner@example.com", primaryUser: "owner" };
  assert.deepEqual(validateSecondAdministrator({
    ...primary, email: " Second@Example.com ", user: " second.admin ",
  }), { email: "second@example.com", user: "second.admin" });
  for (const secondary of [
    { email: "bad", user: "second" },
    { email: "other@example.com", user: "x" },
    { email: "OWNER@example.com", user: "second" },
    { email: "other@example.com", user: "OWNER" },
  ]) {
    assert.throws(() => validateSecondAdministrator({ ...primary, ...secondary }), { statusCode: 400 });
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
