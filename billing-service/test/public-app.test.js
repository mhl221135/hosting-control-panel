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
  assert.match(html, /value="payment_page"/);
  assert.match(source, /reason, updated_at: service\.updated_at/);
});

test("payment-page enforcement follows local hosting compatibility", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../app/public/app.js"), "utf8");
  assert.match(source, /function updateEnforcementCompatibility/);
  assert.match(source, /paymentPage\.disabled = !local/);
  assert.match(source, /elements\.location\.addEventListener\("change", updateEnforcementCompatibility\)/);
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

test("payment review controls expose the reason and audited resolution action", () => {
  const html = fs.readFileSync(path.join(__dirname, "../app/public/index.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "../app/public/app.js"), "utf8");
  assert.match(html, /id="paymentReviewForm"/);
  assert.match(html, /Resolution note/);
  assert.match(source, /data-resolve-payment/);
  assert.match(source, /review\/resolve/);
  assert.match(source, /Renewal dates were not changed/);
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

test("payment option reconciliation stays preview-first and requires CREATE", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../app/public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../app/public/app.js"), "utf8");

  assert.match(html, /id="paymentOptionPreviewBody"/);
  assert.match(html, /Enable daily order creation/);
  assert.match(html, /Type CREATE/);
  assert.match(source, /api\/payment-options\/run/);
  assert.match(source, /confirm: form\.elements\.confirm\.value/);
});

test("WooCommerce settings expose a bounded public support destination", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../app/public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../app/public/app.js"), "utf8");

  assert.match(html, /name="support_url"/);
  assert.match(html, /name="support_label"/);
  assert.match(source, /settings\.supportUrl/);
  assert.match(source, /settings\.supportLabel/);
});
