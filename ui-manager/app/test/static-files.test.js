const assert = require("node:assert/strict");
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
