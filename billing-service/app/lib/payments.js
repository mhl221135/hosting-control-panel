const crypto = require("crypto");
const { integer, validationError } = require("./validation");

const SELECTIONS = new Set(["hosting", "domain", "both"]);

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
    if (service.archived) throw validationError("Archived services cannot create payment links");
    const selection = String(input.selection || "hosting").toLowerCase();
    if (!SELECTIONS.has(selection)) throw validationError("Payment selection must be hosting, domain, or both");
    const active = this.database.activePayment(service.service_id, selection);
    if (active) {
      throw Object.assign(new Error(`An active ${selection} payment link already exists until ${active.expires_at}`), {
        statusCode: 409,
      });
    }
    const includesHosting = selection === "hosting" || selection === "both";
    const includesDomain = selection === "domain" || selection === "both";
    const hostingMonths = includesHosting
      ? integer(input.hosting_months || input.months || service.renewal_months, 1, 120)
      : 0;
    const domainMonths = includesDomain
      ? integer(input.domain_months || service.domain_renewal_months, 1, 120)
      : 0;
    let hostingAmountMinor = includesHosting
      ? integer(input.hosting_amount_minor ?? service.hosting_price_minor, 1, 10_000_000_000)
      : 0;
    let domainAmountMinor = includesDomain
      ? integer(input.domain_amount_minor ?? service.domain_price_minor, 1, 10_000_000_000)
      : 0;
    if (input.amount_minor !== undefined) {
      const override = integer(input.amount_minor, 1, 10_000_000_000);
      if (selection === "hosting") hostingAmountMinor = override;
      else if (selection === "domain") domainAmountMinor = override;
      else if (override !== hostingAmountMinor + domainAmountMinor) {
        throw validationError("Combined payment total must equal its hosting and domain line items");
      }
    }
    const amountMinor = hostingAmountMinor + domainAmountMinor;
    const settings = this.settings.private();
    if (!this.settings.public().ready) throw validationError("WooCommerce integration is not configured");
    const nonce = crypto.randomUUID();
    const resultingHostingPaidThrough = includesHosting
      ? addMonths(service.hosting_paid_through, hostingMonths)
      : "";
    const resultingDomainPaidThrough = includesDomain
      ? addMonths(service.domain_paid_through, domainMonths)
      : "";
    const items = [];
    if (includesHosting) {
      const total = (hostingAmountMinor / 100).toFixed(2);
      items.push({
        product_id: settings.productId,
        quantity: 1,
        subtotal: total,
        total,
        meta_data: [
          { key: "_hosting_service_id", value: service.service_id },
          { key: "_hosting_renewal_item", value: "hosting" },
          { key: "_hosting_renewal_months", value: String(hostingMonths) },
          { key: "_hosting_resulting_paid_through", value: resultingHostingPaidThrough },
          { key: "_hosting_payment_nonce", value: nonce },
        ],
      });
    }
    if (includesDomain) {
      const total = (domainAmountMinor / 100).toFixed(2);
      items.push({
        product_id: settings.productId,
        quantity: 1,
        subtotal: total,
        total,
        meta_data: [
          { key: "_hosting_service_id", value: service.service_id },
          { key: "_hosting_renewal_item", value: "domain" },
          { key: "_hosting_renewal_months", value: String(domainMonths) },
          { key: "_hosting_resulting_paid_through", value: resultingDomainPaidThrough },
          { key: "_hosting_payment_nonce", value: nonce },
        ],
      });
    }
    const order = await this.woo.createOrder({
      status: "pending",
      customer_note: `${selection[0].toUpperCase()}${selection.slice(1)} renewal for ${service.primary_domain}`,
      billing: service.contact_email ? { email: service.contact_email } : undefined,
      line_items: items,
      meta_data: [
        { key: "_hosting_service_id", value: service.service_id },
        { key: "_hosting_payment_nonce", value: nonce },
        { key: "_hosting_renewal_selection", value: selection },
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
      months: hostingMonths || domainMonths,
      resultingPaidThrough: resultingHostingPaidThrough || resultingDomainPaidThrough,
      selection,
      hostingMonths,
      domainMonths,
      resultingHostingPaidThrough,
      resultingDomainPaidThrough,
      expiresAt,
    }, actor);
    return {
      serviceId: service.service_id,
      orderId,
      expiresAt,
      selection,
      amountMinor,
      currency: service.currency,
      hostingMonths,
      domainMonths,
      resultingHostingPaidThrough,
      resultingDomainPaidThrough,
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
