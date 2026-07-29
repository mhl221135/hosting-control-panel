const assert = require("node:assert/strict");
const test = require("node:test");
const { EntitlementRefreshClient } = require("../app/lib/entitlement-refresh");

test("sends only a bearer-authenticated delivery reference", async () => {
  let captured;
  const client = new EntitlementRefreshClient({
    url: "http://hosting-ui.test/internal/v1/billing-entitlements/refresh",
    token: "x".repeat(64),
    fetch: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  await client.trigger("delivery-123");
  assert.equal(captured.options.headers.Authorization, `Bearer ${"x".repeat(64)}`);
  assert.deepEqual(JSON.parse(captured.options.body), { delivery_id: "delivery-123" });
});

test("deduplicates active refreshes and retries bounded failures", async () => {
  let attempts = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const client = new EntitlementRefreshClient({
    url: "http://hosting-ui.test/internal/v1/billing-entitlements/refresh",
    token: "x".repeat(64),
    retryDelaysMs: [0, 0],
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 503, json: async () => ({ message: "temporarily unavailable" }) };
      await waiting;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  const first = client.trigger("delivery-456");
  const duplicate = client.trigger("delivery-456");
  assert.equal(first, duplicate);
  release();
  await first;
  assert.equal(attempts, 2);
});
