const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  authorized,
  validatedEntitlementRefresh,
  validatedReminder,
} = require("../lib/billing-notification-api");

test("requires the exact long billing bearer token", () => {
  const token = crypto.randomBytes(32).toString("hex");
  assert.equal(authorized({ headers: { authorization: `Bearer ${token}` } }, token), true);
  assert.equal(authorized({ headers: { authorization: "Bearer wrong" } }, token), false);
  assert.equal(authorized({ headers: {} }, token), false);
});

test("constructs a bounded reminder event from allowlisted billing fields", () => {
  assert.deepEqual(validatedReminder({
    service_id: "svc_1234567890",
    domain: "Example.COM",
    state: "grace",
    paid_through: "2026-07-20",
    days_remaining: -8,
    reminder_key: "a".repeat(64),
  }), {
    eventType: "billing-reminder",
    eventId: "a".repeat(64),
    dedupeKey: `billing-reminder:${"a".repeat(64)}`,
    severity: "warning",
    label: "Hosting renewal overdue: example.com",
    status: "grace",
    targets: ["example.com"],
    message: "Paid through 2026-07-20; 8 days overdue. Service svc_1234567890.",
    respectSeverityFilter: false,
  });
});

test("rejects arbitrary messages, invalid states, dates, IDs, and keys", () => {
  const valid = {
    service_id: "svc_1234567890",
    domain: "example.com",
    state: "reminder",
    paid_through: "2026-08-01",
    days_remaining: 4,
    reminder_key: "b".repeat(64),
  };
  assert.equal(validatedReminder({ ...valid, message: "ignored" }).message.includes("ignored"), false);
  for (const change of [
    { service_id: "../etc" },
    { domain: "localhost" },
    { state: "paid" },
    { paid_through: "2026-02-31" },
    { days_remaining: 1.5 },
    { reminder_key: "short" },
  ]) assert.throws(() => validatedReminder({ ...valid, ...change }));
});

test("accepts only a bounded WooCommerce delivery reference for entitlement refresh", () => {
  assert.deepEqual(validatedEntitlementRefresh({ delivery_id: "delivery-123:updated" }), {
    deliveryId: "delivery-123:updated",
  });
  for (const deliveryId of ["", "../delivery", "contains spaces", "x".repeat(161)]) {
    assert.throws(() => validatedEntitlementRefresh({ delivery_id: deliveryId }));
  }
});
