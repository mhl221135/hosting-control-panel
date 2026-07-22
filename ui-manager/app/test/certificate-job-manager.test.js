const assert = require("node:assert/strict");
const test = require("node:test");
const { CertificateJobManager, certificateId } = require("../lib/certificate-job-manager");

function fixture(npm = {}) {
  const handlers = new Map();
  const created = [];
  const jobManager = {
    register(type, handler) { handlers.set(type, handler); },
    create(input) { created.push(input); return { id: "job-1", ...input }; },
  };
  return { handlers, created, manager: new CertificateJobManager({ jobManager, npm }) };
}

test("validates certificate IDs and creates non-retryable conflicting jobs", () => {
  const context = fixture();
  assert.equal(certificateId("42"), 42);
  assert.throws(() => certificateId(0), (error) => error.statusCode === 400);
  const issue = context.manager.enqueueIssue(["example.com", "www.example.com"], "operator@example");
  const renew = context.manager.enqueueRenew("example.com", 42, "operator@example");
  assert.equal(issue.retryable, false);
  assert.equal(issue.cancellable, false);
  assert.deepEqual(issue.conflicts, ["integration:npm", "site:example.com", "site:www.example.com"]);
  assert.deepEqual(renew.payload, { domain: "example.com", certificateId: 42 });
  assert.match(renew.idempotencyKey, /example\.com:42$/);
});

test("issues a certificate and persists only a bounded result", async () => {
  const calls = [];
  const context = fixture({
    async ensureHost(domains, issueSsl) {
      calls.push({ domains, issueSsl });
      return { id: 9, certificate_id: 31, access_list: { secret: "not persisted" } };
    },
  });
  const updates = [];
  const result = await context.handlers.get("npm.certificate.issue")({ update: (value) => updates.push(value) }, { domains: ["example.com"] });
  assert.deepEqual(calls, [{ domains: ["example.com"], issueSsl: true }]);
  assert.equal(result.results[0].certificateId, 31);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.match(updates[0].currentStep, /Requesting certificate/);
});

test("renews only a certificate still attached to the selected domain", async () => {
  const renewed = [];
  const context = fixture({
    async listHosts() { return [{ certificate_id: 42, domain_names: ["example.com", "www.example.com"] }]; },
    async renewCertificate(id) { renewed.push(id); return { id, provider: "ignored" }; },
  });
  const handler = context.handlers.get("npm.certificate.renew");
  const job = { update() {} };
  const result = await handler(job, { domain: "example.com", certificateId: 42 });
  assert.deepEqual(renewed, [42]);
  assert.equal(result.results[0].certificateId, 42);
  await assert.rejects(() => handler(job, { domain: "other.example", certificateId: 42 }), /no longer attached/);
});
