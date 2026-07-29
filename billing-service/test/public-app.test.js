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

test("pending payment actions expose reasoned cancellation and replacement", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../app/public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../app/public/app.js"), "utf8");

  assert.match(html, /id="paymentCancelForm"/);
  assert.match(html, /name="replacement_reason"/);
  assert.match(source, /data-cancel-payment/);
  assert.match(source, /data-replace-payment/);
  assert.match(source, /replace_payment_id: form\.elements\.replace_payment_id\.value/);
});

test("public renewal key rotation requires an explicit reason and confirmation", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../app/public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../app/public/app.js"), "utf8");

  assert.match(html, /id="referenceRotationForm"/);
  assert.match(html, /name="overlap_hours"/);
  assert.match(html, /Type ROTATE/);
  assert.match(source, /api\/public-reference\/rotate/);
  assert.match(source, /reason: form\.elements\.reason\.value/);
});
