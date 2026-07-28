const crypto = require("crypto");
const { integer, validationError } = require("./validation");

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function addMonths(dateValue, months, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const current = dateValue ? new Date(`${dateValue}T00:00:00Z`) : today;
  const base = current > today ? current : today;
  const day = base.getUTCDate();
  const result = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result.toISOString().slice(0, 10);
}

function webhookValid(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(rawBody).digest("base64"));
  const actual = Buffer.from(String(signature));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

class PaymentManager {
  constructor(database, settings, wooClient) {
    this.database = database;
    this.settings = settings;
    this.woo = wooClient;
  }

  async create(serviceId, input, actor) {
    const service = this.database.service(serviceId);
    if (!service) throw Object.assign(new Error("Billing service was not found"), { statusCode: 404 });
    const active = this.database.activePayment(service.service_id);
    if (active) {
      throw Object.assign(new Error(`An active payment link already exists until ${active.expires_at}`), {
        statusCode: 409,
      });
    }
    const months = integer(input.months || service.renewal_months, 1, 120);
    const amountMinor = integer(
      input.amount_minor === undefined ? service.hosting_price_minor : input.amount_minor,
      1,
      10_000_000_000,
    );
    const settings = this.settings.private();
    if (!this.settings.public().ready) throw validationError("WooCommerce integration is not configured");
    const nonce = crypto.randomUUID();
    const paidThrough = addMonths(service.hosting_paid_through, months);
    const total = (amountMinor / 100).toFixed(2);
    const order = await this.woo.createOrder({
      status: "pending",
      customer_note: `Hosting renewal for ${service.primary_domain}`,
      billing: service.contact_email ? { email: service.contact_email } : undefined,
      line_items: [{
        product_id: settings.productId,
        quantity: 1,
        subtotal: total,
        total,
        meta_data: [
          { key: "_hosting_service_id", value: service.service_id },
          { key: "_hosting_renewal_months", value: String(months) },
          { key: "_hosting_resulting_paid_through", value: paidThrough },
          { key: "_hosting_payment_nonce", value: nonce },
        ],
      }],
      meta_data: [
        { key: "_hosting_service_id", value: service.service_id },
        { key: "_hosting_payment_nonce", value: nonce },
      ],
    });
    const orderId = Number(order.id);
    const orderKey = String(order.order_key || "");
    if (!Number.isInteger(orderId) || orderId < 1 || !orderKey) throw new Error("WooCommerce returned an incomplete order");
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + settings.linkHours * 3_600_000).toISOString();
    const checkoutUrl = `${settings.siteUrl}/checkout/order-pay/${orderId}/?pay_for_order=true&key=${encodeURIComponent(orderKey)}`;
    this.database.createPayment({
      paymentId: crypto.randomUUID(),
      serviceId: service.service_id,
      tokenHash: tokenHash(token),
      nonce,
      wooOrderId: orderId,
      checkoutUrl,
      amountMinor,
      currency: service.currency,
      months,
      resultingPaidThrough: paidThrough,
      expiresAt,
    }, actor);
    return {
      serviceId: service.service_id,
      orderId,
      expiresAt,
      paymentUrl: `${settings.publicBillingUrl}/pay/${token}`,
    };
  }

  resolve(token) {
    return this.database.resolvePayment(tokenHash(token));
  }

  webhook(rawBody, headers) {
    const settings = this.settings.private();
    if (!webhookValid(rawBody, headers.signature, settings.webhookSecret)) {
      throw Object.assign(new Error("Invalid WooCommerce webhook signature"), { statusCode: 401 });
    }
    let order;
    try {
      order = JSON.parse(rawBody);
    } catch {
      throw validationError("Webhook body must be valid JSON");
    }
    const deliveryId = String(headers.deliveryId || "").slice(0, 160);
    if (!deliveryId) throw validationError("WooCommerce delivery ID is required");
    const topic = String(headers.topic || "").slice(0, 80);
    if (!["order.created", "order.updated"].includes(topic)) throw validationError("Unsupported WooCommerce webhook topic");
    return this.database.processWebhook({
      deliveryId,
      topic,
      resourceId: Number(order.id || 0),
      status: String(order.status || "").toLowerCase(),
      totalMinor: Math.round(Number(order.total || 0) * 100),
      currency: String(order.currency || "").toUpperCase(),
    });
  }
}

module.exports = { PaymentManager, addMonths, tokenHash, webhookValid };
