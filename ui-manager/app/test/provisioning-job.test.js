const assert = require("node:assert/strict");
const test = require("node:test");
const { jobInput, safeProvisionPayload } = require("../lib/provisioning-job");

test("provisioning jobs never persist submitted administrator passwords", () => {
  const request = safeProvisionPayload({
    domain: "example.com",
    admin_password: "do-not-persist",
    plugin_packages: ["plugin-id"],
    unknown: "discarded",
  });
  assert.deepEqual(request, { domain: "example.com", plugin_packages: ["plugin-id"] });
  const input = jobInput({ body: request, domain: "example.com", operator: "admin@example.com" });
  assert.equal(JSON.stringify(input).includes("do-not-persist"), false);
  assert.deepEqual(input.conflicts, ["server-heavy", "runtime-config", "site:example.com"]);
  assert.equal(input.retryable, false);
});
