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

test("manual overrides use reasoned actions instead of an unaudited state selector", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../app/public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../app/public/app.js"), "utf8");

  assert.doesNotMatch(html, /<select name="manual_state">/);
  assert.match(html, /data-manual-action="exempt"/);
  assert.match(html, /data-manual-action="resume"/);
  assert.match(html, /data-manual-action="suspend"/);
  assert.match(source, /reason, updated_at: service\.updated_at/);
});
