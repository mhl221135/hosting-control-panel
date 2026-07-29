const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { importCsv } = require("../app/lib/csv");
const { BillingDatabase } = require("../app/lib/database");
const { PaymentManager, addMonths, webhookValid } = require("../app/lib/payments");
const { PublicReference } = require("../app/lib/public-reference");
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
    "Order #,Website,Hosting Next Payment,Domain Next Payment,Hosting Months,Domain Months,Price Hosting,Price Domain,Currency,Email",
    "42,example.com,2026-12-31,2027-01-15,12,24,120.00,18.25,USD,owner@example.com",
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
    assert.equal(payload.line_items[0].meta_data.some((item) => item.value === "hosting"), true);
        return { id: 1234, order_key: "wc_order_private" };
      },
    };
    const manager = new PaymentManager(value.database, value.settings, woo);
    const created = await manager.create(value.database.services()[0].service_id, {}, "admin@example.com");
    assert.match(created.paymentUrl, /^https:\/\/billing\.example\.com\/pay\/[A-Za-z0-9_-]{43}$/);
    await assert.rejects(
      manager.create(value.database.services()[0].service_id, {}, "admin@example.com"),
      /active hosting payment link already exists/,
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

test("creates domain and combined selections and updates only purchased dates", async () => {
  const value = fixture();
  try {
    let orderId = 2000;
    const payloads = [];
    const manager = new PaymentManager(value.database, value.settings, {
      createOrder: async (payload) => {
        payloads.push(payload);
        orderId += 1;
        return { id: orderId, order_key: `wc_order_${orderId}` };
      },
    });
    const serviceId = value.database.services()[0].service_id;
    const domain = await manager.create(serviceId, { selection: "domain" }, "admin@example.com");
    assert.equal(domain.amountMinor, 1825);
    assert.equal(domain.domainMonths, 24);
    assert.equal(domain.resultingDomainPaidThrough, "2029-01-15");
    assert.equal(payloads[0].line_items.length, 1);
    assert.equal(payloads[0].line_items[0].meta_data.some((item) => item.value === "domain"), true);
    const secret = value.settings.private().webhookSecret;
    const domainBody = JSON.stringify({ id: 2001, status: "completed", total: "18.25", currency: "USD" });
    const domainSignature = crypto.createHmac("sha256", secret).update(domainBody).digest("base64");
    assert.equal(manager.webhook(domainBody, {
      signature: domainSignature,
      deliveryId: "delivery-domain",
      topic: "order.updated",
    }).result, "paid");
    assert.equal(value.database.service(serviceId).hosting_paid_through, "2026-12-31");
    assert.equal(value.database.service(serviceId).domain_paid_through, "2029-01-15");

    const both = await manager.create(serviceId, {
      selection: "both",
      hosting_months: 6,
      domain_months: 12,
    }, "admin@example.com");
    assert.equal(both.amountMinor, 13825);
    assert.equal(payloads[1].line_items.length, 2);
    const bothBody = JSON.stringify({ id: 2002, status: "processing", total: "138.25", currency: "USD" });
    const bothSignature = crypto.createHmac("sha256", secret).update(bothBody).digest("base64");
    assert.equal(manager.webhook(bothBody, {
      signature: bothSignature,
      deliveryId: "delivery-both",
      topic: "order.updated",
    }).result, "paid");
    const updated = value.database.service(serviceId);
    assert.equal(updated.hosting_paid_through, both.resultingHostingPaidThrough);
    assert.equal(updated.domain_paid_through, both.resultingDomainPaidThrough);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("cancels and replaces pending orders without leaving duplicate active links", async () => {
  const value = fixture();
  try {
    let orderId = 5000;
    const cancelled = [];
    const manager = new PaymentManager(value.database, value.settings, {
      createOrder: async () => {
        orderId += 1;
        return { id: orderId, order_key: `wc_order_${orderId}` };
      },
      cancelOrder: async (id) => {
        cancelled.push(id);
        return { id, status: "cancelled" };
      },
    });
    const serviceId = value.database.services()[0].service_id;
    const first = await manager.create(serviceId, {}, "admin@example.com");
    const firstPayment = value.database.activePayment(serviceId, "hosting");
    await assert.rejects(
      manager.cancel(firstPayment.payment_id, "x", "admin@example.com"),
      /at least 3 characters/,
    );
    assert.deepEqual(cancelled, []);
    const cancelledPayment = await manager.cancel(
      firstPayment.payment_id, "Customer requested a new link", "admin@example.com",
    );
    assert.equal(cancelledPayment.status, "cancelled");
    assert.throws(() => manager.resolve(first.paymentUrl.split("/").pop()), /no longer active/);
    assert.equal(value.database.audit()[0].action, "payment.cancel");

    await manager.create(serviceId, {}, "admin@example.com");
    const secondPayment = value.database.activePayment(serviceId, "hosting");
    const replacement = await manager.create(serviceId, {
      selection: "hosting",
      replace_payment_id: secondPayment.payment_id,
      replacement_reason: "Corrected renewal order",
    }, "admin@example.com");
    assert.equal(replacement.orderId, 5003);
    assert.deepEqual(cancelled, [5001, 5002]);
    assert.equal(value.database.payment(secondPayment.payment_id).status, "cancelled");
    assert.equal(value.database.activePayment(serviceId, "hosting").woo_order_id, 5003);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("keeps the local payment pending when WooCommerce does not confirm cancellation", async () => {
  const value = fixture();
  try {
    const manager = new PaymentManager(value.database, value.settings, {
      createOrder: async () => ({ id: 6001, order_key: "wc_order_6001" }),
      cancelOrder: async (id) => ({ id, status: "processing" }),
    });
    const serviceId = value.database.services()[0].service_id;
    await manager.create(serviceId, {}, "admin@example.com");
    const payment = value.database.activePayment(serviceId, "hosting");
    await assert.rejects(
      manager.cancel(payment.payment_id, "Operator cancellation", "admin@example.com"),
      /did not confirm/,
    );
    assert.equal(value.database.payment(payment.payment_id).status, "pending");
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("uses stable opaque public references and exposes only active matching payments", async () => {
  const value = fixture();
  try {
    const service = value.database.services()[0];
    const references = new PublicReference(value.root);
    const reference = references.forService(service.service_id);
    assert.match(reference, /^r1_[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(reference, /example|svc_/);
    assert.equal(references.resolve(reference, value.database.services()).service_id, service.service_id);
    assert.equal(references.resolve(`${reference.slice(0, -1)}x`, value.database.services()), null);
    const manager = new PaymentManager(value.database, value.settings, {
      createOrder: async () => ({ id: 3001, order_key: "wc_order_public" }),
    });
    await manager.create(service.service_id, { selection: "hosting" }, "admin@example.com");
    const available = value.database.publicPayments(service.service_id);
    assert.equal(available.length, 1);
    assert.equal(available[0].selection, "hosting");
    assert.equal(Object.hasOwn(available[0], "checkout_url"), false);
    assert.match(value.database.resolvePublicPayment(service.service_id, available[0].payment_id), /wc_order_public/);
    assert.throws(
      () => value.database.resolvePublicPayment("svc_wrong_service", available[0].payment_id),
      /not found/,
    );
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
