const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("submit handlers do not defer access through event.currentTarget", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../app/public/app.js"), "utf8");

  assert.doesNotMatch(source, /new FormData\(event\.currentTarget\)/);
  assert.doesNotMatch(source, /event\.currentTarget\.elements/);
  assert.doesNotMatch(source, /event\.currentTarget\.(?:reset|hidden)/);
});
