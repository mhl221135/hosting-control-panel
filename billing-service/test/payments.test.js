const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { importCsv } = require("../app/lib/csv");
const { BillingDatabase } = require("../app/lib/database");
const { PaymentManager, addMonths, webhookValid } = require("../app/lib/payments");
const { WooCommerceSettings } = require("../app/lib/woocommerce-settings");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-billing-payments-"));
  const database = new BillingDatabase(root);
  const settings = new WooCommerceSettings(root);
  settings.update({
    site_url: "https://store.example.com",
    public_billing_url: "https://billing.example.com",
    product_id: 99,
    link_hours: 48,
    consumer_key: `ck_${"a".repeat(40)}`,
    consumer_secret: `cs_${"b".repeat(40)}`,
    webhook_secret: "webhook-secret-with-enough-entropy",
  });
  const input = importCsv([
    "Order #,Website,Hosting Next Payment,Price Hosting,Currency,Email",
    "42,example.com,2026-12-31,120.00,USD,owner@example.com",
  ].join("\n"));
  database.importServices(input.services, input.fingerprint, "admin@example.com");
  return { root, database, settings };
}

test("encrypts WooCommerce credentials and preserves blank secret updates", () => {
  const value = fixture();
  try {
    const raw = fs.readFileSync(path.join(value.root, "woocommerce-settings.json"), "utf8");
    assert.doesNotMatch(raw, /ck_aaaa|cs_bbbb|webhook-secret/);
    const updated = value.settings.update({
      site_url: "https://store.example.com",
      public_billing_url: "https://billing.example.com",
      product_id: 99,
      link_hours: 72,
      consumer_key: "",
      consumer_secret: "",
      webhook_secret: "",
    });
    assert.equal(updated.ready, true);
    assert.equal(updated.linkHours, 72);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("creates opaque expiring links and applies a valid paid webhook once", async () => {
  const value = fixture();
  try {
    const woo = {
      createOrder: async (payload) => {
        assert.equal(payload.line_items[0].product_id, 99);
        assert.equal(payload.line_items[0].total, "120.00");
        return { id: 1234, order_key: "wc_order_private" };
      },
    };
    const manager = new PaymentManager(value.database, value.settings, woo);
    const created = await manager.create(value.database.services()[0].service_id, {}, "admin@example.com");
    assert.match(created.paymentUrl, /^https:\/\/billing\.example\.com\/pay\/[A-Za-z0-9_-]{43}$/);
    await assert.rejects(
      manager.create(value.database.services()[0].service_id, {}, "admin@example.com"),
      /active payment link already exists/,
    );
    assert.doesNotMatch(JSON.stringify(value.database.payments()), /wc_order_private|\/pay\//);
    const token = created.paymentUrl.split("/").pop();
    assert.match(manager.resolve(token), /order-pay\/1234\/\?pay_for_order=true&key=wc_order_private/);

    const body = JSON.stringify({ id: 1234, status: "processing", total: "120.00", currency: "USD" });
    const secret = value.settings.private().webhookSecret;
    const signature = crypto.createHmac("sha256", secret).update(body).digest("base64");
    const result = manager.webhook(body, {
      signature,
      deliveryId: "delivery-1",
      topic: "order.updated",
    });
    assert.deepEqual(result, { duplicate: false, result: "paid" });
    assert.equal(value.database.service(value.database.services()[0].service_id).hosting_paid_through, "2027-12-31");
    assert.throws(() => manager.resolve(token), /no longer active/);
    assert.deepEqual(manager.webhook(body, {
      signature,
      deliveryId: "delivery-1",
      topic: "order.updated",
    }), { duplicate: true, result: "paid" });
    assert.equal(value.database.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='payment.completed'").get().count, 1);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects forged webhooks and does not apply mismatched amounts or refunds", async () => {
  const value = fixture();
  try {
    const manager = new PaymentManager(value.database, value.settings, {
      createOrder: async () => ({ id: 4321, order_key: "wc_order_second" }),
    });
    const serviceId = value.database.services()[0].service_id;
    await manager.create(serviceId, {}, "admin@example.com");
    const secret = value.settings.private().webhookSecret;
    const mismatchBody = JSON.stringify({ id: 4321, status: "completed", total: "1.00", currency: "USD" });
    const mismatchSignature = crypto.createHmac("sha256", secret).update(mismatchBody).digest("base64");
    assert.equal(manager.webhook(mismatchBody, {
      signature: mismatchSignature,
      deliveryId: "delivery-mismatch",
      topic: "order.updated",
    }).result, "amount_mismatch");
    assert.equal(value.database.service(serviceId).hosting_paid_through, "2026-12-31");

    const refundBody = JSON.stringify({ id: 4321, status: "refunded", total: "120.00", currency: "USD" });
    const refundSignature = crypto.createHmac("sha256", secret).update(refundBody).digest("base64");
    assert.equal(manager.webhook(refundBody, {
      signature: refundSignature,
      deliveryId: "delivery-refund",
      topic: "order.updated",
    }).result, "review_required");
    assert.equal(value.database.service(serviceId).hosting_paid_through, "2026-12-31");
    assert.throws(() => manager.webhook(refundBody, {
      signature: "invalid",
      deliveryId: "forged",
      topic: "order.updated",
    }), /signature/);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("clamps month arithmetic and verifies webhook signatures timing-safely", () => {
  assert.equal(addMonths("2026-01-31", 1, new Date("2026-01-01T00:00:00Z")), "2026-02-28");
  const body = "{}";
  const secret = "a-long-webhook-secret-value";
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(webhookValid(body, signature, secret), true);
  assert.equal(webhookValid(body, `${signature}x`, secret), false);
});
