const assert = require("node:assert/strict");
const test = require("node:test");
const { provisionSecurityStep, selectedProvisionSecurity } = require("../lib/provision-security");

test("validates opt-in provisioning security presets by site capability", () => {
  assert.equal(selectedProvisionSecurity({}, "wordpress"), "");
  assert.equal(selectedProvisionSecurity({ apply_security_preset: true, security_preset: "suspicious-probes" }, "static"), "suspicious-probes");
  assert.equal(selectedProvisionSecurity({ apply_security_preset: true, security_preset: "xmlrpc-challenge" }, "wordpress"), "xmlrpc-challenge");
  assert.throws(() => selectedProvisionSecurity({ apply_security_preset: true, security_preset: "unknown" }, "wordpress"), (error) => error.statusCode === 400);
  assert.throws(() => selectedProvisionSecurity({ apply_security_preset: true, security_preset: "login-rate-limit" }, "static"), /requires WordPress/);
});

test("maps Cloudflare application failures to provisioning warnings", async () => {
  const success = await provisionSecurityStep({ applySecurityPreset: async () => ({ created: true }) }, "example.com", "suspicious-probes");
  assert.deepEqual(success, { name: "cloudflare-security", status: "complete", preset: "suspicious-probes", created: true });
  const warning = await provisionSecurityStep({ applySecurityPreset: async () => { throw new Error("plan does not allow this rule"); } }, "example.com", "login-rate-limit");
  assert.equal(warning.status, "warning");
  assert.match(warning.message, /plan does not allow/);
  assert.equal(await provisionSecurityStep({}, "example.com", ""), null);
});
