const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { resolvePublicFile } = require("../lib/static-files");

test("resolves versioned public assets by URL pathname", () => {
  assert.equal(resolvePublicFile("/app/public", "/app.js?v=20260721-1"), "/app/public/app.js");
  assert.equal(resolvePublicFile("/app/public", "/"), "/app/public/index.html");
});

test("rejects public paths that escape the configured root", () => {
  assert.equal(resolvePublicFile("/app/public", "/..%2Fserver.js"), null);
  assert.equal(resolvePublicFile("/app/public", "/%E0%A4%A"), null);
});

test("backup restore UI exposes an explicit opt-in billing choice", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  assert.match(html, /id="restoreBackupDialog"/);
  assert.match(html, /name="register_billing"/);
  assert.match(html, /name="billing_grant_free_period"/);
  assert.match(source, /restoreBackupDialog.*showModal/s);
  assert.match(source, /JSON\.stringify\(formObject\(form\)\)/);
});

test("settings expose guarded billing enforcement controls", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  assert.match(html, /id="billingEnforcementSettingsForm"/);
  assert.match(html, /id="billingEnforcementHistory"/);
  assert.match(html, /Enable billing enforcement globally/);
  assert.match(html, /id="billingPilotSites"/);
  assert.match(html, /id="billingPilotSearch"/);
  assert.doesNotMatch(html, /name="pilotDomains"/);
  assert.match(html, /id="reconcileBillingEnforcement"/);
  assert.match(html, /id="disableBillingEnforcement"/);
  assert.match(source, /api\/billing\/enforcement\/reconcile/);
  assert.match(source, /api\/billing\/enforcement\/disable/);
  assert.match(source, /selectedBillingPilotDomains/);
});

test("runtime exposes an editable PHP-FPM profile form", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(html, /id="poolPresetsEditor"/);
  assert.match(html, /id="savePoolPresets"/);
  assert.match(source, /data-preset-field="max_children"/);
  assert.match(source, /method: "PUT"[\s\S]*\/api\/pool-presets/);
  assert.match(source, /data-preset-field="request_terminate_timeout"/);
  assert.match(source, /renderPoolCapacity/);
  assert.match(source, /Worst-case PHP ceiling/);
  assert.match(source, /Custom \/ drifted/);
  assert.match(source, /Settings differ from every preset/);
  assert.match(source, /\/api\/pool-presets\/preview/);
  assert.match(html, /Preview impact/);
  assert.match(source, /Existing pools were not changed/);
  assert.match(source, /pool ports verified/);
  assert.match(server, /resolvePoolSectionName/);
  assert.match(html, /Apply to existing pools/);
  assert.match(source, /poolPresetApplyPreview\.tiers/);
  assert.match(source, /change\.field/);
  assert.match(source, /Preset values changed after preview/);
});

test("runtime exposes a PHP-FPM audit history section", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(html, /id="phpFpmAuditHistory"/);
  assert.match(html, /id="refreshPhpFpmAudit"/);
  assert.match(source, /api\/pool-presets\/audit/);
  assert.match(source, /function loadPhpFpmAudit/);
  assert.match(source, /function renderPhpFpmAudit/);
  assert.match(source, /escapeHtml\(event\.operator/);
  assert.match(source, /No PHP-FPM audit events recorded/);
  assert.match(source, /rollback/);
  assert.match(server, /phpFpmAudit\.record/);
  assert.match(server, /operation: "apply"/);
  assert.match(server, /requestUrl\.pathname === "\/api\/pool-presets\/audit"/);
  assert.match(server, /error\.executionStarted === true/);
  assert.match(server, /error\.rollbackStatus \|\| "not-required"/);
  assert.match(server, /throw error/);
});
