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
