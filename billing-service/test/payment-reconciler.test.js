const assert = require("node:assert/strict");
const test = require("node:test");
const { PaymentOptionReconciler } = require("../app/lib/payment-reconciler");

function service(id, overrides = {}) {
  return {
    service_id: id,
    primary_domain: `${id}.example.com`,
    hosting_state: "reminder",
    domain_state: "reminder",
    hosting_paid_through: "2026-08-01",
    domain_paid_through: "2026-08-01",
    hosting_price_minor: 8000,
    domain_price_minor: 2000,
    currency: "USD",
    ...overrides,
  };
}

test("previews refresh, create, and blocked overlapping payment options", async () => {
  const services = [
    service("refresh"),
    service("domain", { hosting_state: "active" }),
    service("blocked"),
    service("free", { hosting_price_minor: 0, domain_price_minor: 0 }),
  ];
  const active = new Map();
  const latest = new Map([
    ["refresh:both", { selection: "both", status: "expired", woo_order_id: 11 }],
    ["blocked:hosting", { selection: "hosting", status: "expired", woo_order_id: 12 }],
  ]);
  const audit = [];
  const database = {
    services: () => services,
    activePayment: (id, selection) => active.get(`${id}:${selection}`) || null,
    latestPayment: (id, selection) => latest.get(`${id}:${selection}`) || null,
    auditEntry: (...entry) => audit.push(entry),
    paymentOptionSettings: () => ({ enabled: false, time: "08:30", lastRun: "" }),
  };
  const calls = [];
  const payments = {
    refreshExpired: async (id, selection) => {
      calls.push(["refresh", id, selection]);
      return { orderId: 101 };
    },
    create: async (id, input) => {
      calls.push(["create", id, input.selection]);
      return { orderId: 102 };
    },
  };
  const reconciler = new PaymentOptionReconciler(database, payments, { timezone: "UTC" });
  const preview = reconciler.preview(new Date("2026-07-29T12:00:00Z"));
  assert.deepEqual(preview.map((item) => [item.service_id, item.selection, item.action]), [
    ["refresh", "both", "refresh"],
    ["domain", "domain", "create"],
    ["blocked", "both", "blocked"],
  ]);
  const result = await reconciler.run("admin@example.com", new Date("2026-07-29T12:00:00Z"));
  assert.deepEqual(calls, [["refresh", "refresh", "both"], ["create", "domain", "domain"]]);
  assert.equal(result.blocked, 1);
  assert.equal(result.results.every((item) => item.ok), true);
  assert.equal(audit[0][1], "payment_options.run");
});

test("keeps the payment option scheduler disabled by default and runs once per date", async () => {
  let settings = { enabled: false, time: "09:00", lastRun: "" };
  let runs = 0;
  const database = {
    paymentOptionSettings: () => settings,
    setPaymentOptionLastRun: (date) => { settings = { ...settings, lastRun: date }; },
  };
  const reconciler = new PaymentOptionReconciler(database, {}, { timezone: "UTC" });
  reconciler.run = async () => {
    runs += 1;
    return { candidates: 0, blocked: 0, results: [] };
  };
  assert.equal(await reconciler.tick(new Date("2026-07-29T10:00:00Z")), null);
  settings = { ...settings, enabled: true };
  await reconciler.tick(new Date("2026-07-29T10:00:00Z"));
  await reconciler.tick(new Date("2026-07-29T11:00:00Z"));
  assert.equal(runs, 1);
  assert.equal(settings.lastRun, "2026-07-29");
});

test("bounds each reconciliation run to ten WooCommerce orders", async () => {
  const services = Array.from({ length: 12 }, (_, index) =>
    service(`site-${index}`, { domain_state: "active" }));
  const database = {
    services: () => services,
    activePayment: () => null,
    latestPayment: () => null,
    auditEntry: () => {},
  };
  let created = 0;
  const reconciler = new PaymentOptionReconciler(database, {
    create: async () => {
      created += 1;
      return { orderId: created };
    },
  });
  const result = await reconciler.run("scheduler", new Date("2026-07-29T12:00:00Z"));
  assert.equal(created, 10);
  assert.equal(result.deferred, 2);
  assert.equal(result.results.length, 10);
});
