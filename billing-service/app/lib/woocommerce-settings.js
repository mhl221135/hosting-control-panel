const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { domain, integer, validationError } = require("./validation");

function httpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw validationError(`${label} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw validationError(`${label} must be a valid HTTPS URL without embedded credentials`);
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

class WooCommerceSettings {
  constructor(dataDir) {
    this.file = path.join(dataDir, "woocommerce-settings.json");
    this.keyFile = path.join(dataDir, "woocommerce-settings.key");
    this.key = this.loadKey();
  }

  loadKey() {
    if (process.env.BILLING_SETTINGS_KEY) {
      return crypto.createHash("sha256").update(process.env.BILLING_SETTINGS_KEY).digest();
    }
    if (fs.existsSync(this.keyFile)) return Buffer.from(fs.readFileSync(this.keyFile, "utf8").trim(), "base64url");
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyFile, key.toString("base64url"), { mode: 0o600 });
    return key;
  }

  encrypt(value) {
    if (!value) return "";
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((item) => item.toString("base64url")).join(".");
  }

  decrypt(value) {
    if (!value) return "";
    try {
      const [iv, tag, encrypted] = value.split(".").map((item) => Buffer.from(item, "base64url"));
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Stored WooCommerce credentials cannot be decrypted");
    }
  }

  stored() {
    if (!fs.existsSync(this.file)) return {};
    return JSON.parse(fs.readFileSync(this.file, "utf8"));
  }

  private() {
    const stored = this.stored();
    return {
      siteUrl: stored.siteUrl || "",
      publicBillingUrl: stored.publicBillingUrl || "",
      productId: Number(stored.productId || 0),
      linkHours: Number(stored.linkHours || 72),
      consumerKey: this.decrypt(stored.consumerKey),
      consumerSecret: this.decrypt(stored.consumerSecret),
      webhookSecret: this.decrypt(stored.webhookSecret),
    };
  }

  public() {
    const settings = this.private();
    return {
      siteUrl: settings.siteUrl,
      publicBillingUrl: settings.publicBillingUrl,
      productId: settings.productId,
      linkHours: settings.linkHours,
      consumerKeyConfigured: Boolean(settings.consumerKey),
      consumerSecretConfigured: Boolean(settings.consumerSecret),
      webhookSecretConfigured: Boolean(settings.webhookSecret),
      ready: Boolean(settings.siteUrl && settings.publicBillingUrl && settings.productId
        && settings.consumerKey && settings.consumerSecret && settings.webhookSecret),
    };
  }

  update(input) {
    const current = this.private();
    const siteUrl = httpsUrl(input.site_url, "WooCommerce URL");
    const publicBillingUrl = httpsUrl(input.public_billing_url, "Public billing URL");
    domain(new URL(siteUrl).hostname);
    domain(new URL(publicBillingUrl).hostname);
    const productId = integer(input.product_id, 1, 2_147_483_647);
    const linkHours = integer(input.link_hours, 1, 720, 72);
    const consumerKey = String(input.consumer_key || current.consumerKey);
    const consumerSecret = String(input.consumer_secret || current.consumerSecret);
    const webhookSecret = String(input.webhook_secret || current.webhookSecret);
    if (!/^ck_[A-Za-z0-9]{20,}$/.test(consumerKey)) throw validationError("WooCommerce consumer key is invalid");
    if (!/^cs_[A-Za-z0-9]{20,}$/.test(consumerSecret)) throw validationError("WooCommerce consumer secret is invalid");
    if (webhookSecret.length < 24) throw validationError("Webhook secret must contain at least 24 characters");
    fs.writeFileSync(this.file, JSON.stringify({
      version: 1,
      siteUrl,
      publicBillingUrl,
      productId,
      linkHours,
      consumerKey: this.encrypt(consumerKey),
      consumerSecret: this.encrypt(consumerSecret),
      webhookSecret: this.encrypt(webhookSecret),
      updatedAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
    return this.public();
  }
}

class WooCommerceClient {
  constructor(settings, fetchImpl = fetch) {
    this.settings = settings;
    this.fetch = fetchImpl;
  }

  async request(pathname, options = {}) {
    const settings = this.settings.private();
    if (!this.settings.public().ready) throw validationError("WooCommerce integration is not configured");
    const authorization = Buffer.from(`${settings.consumerKey}:${settings.consumerSecret}`).toString("base64");
    const response = await this.fetch(`${settings.siteUrl}/wp-json/wc/v3${pathname}`, {
      ...options,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${authorization}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(`WooCommerce request failed with HTTP ${response.status}`), {
        statusCode: 502,
        details: String(body.message || "").slice(0, 300),
      });
    }
    return body;
  }

  async test() {
    const settings = this.settings.private();
    const product = await this.request(`/products/${settings.productId}`);
    return { ok: true, productId: Number(product.id), productName: String(product.name || "").slice(0, 160) };
  }

  async createOrder(payload) {
    return this.request("/orders", { method: "POST", body: JSON.stringify(payload) });
  }

  async cancelOrder(orderId) {
    return this.request(`/orders/${Number(orderId)}`, {
      method: "PUT",
      body: JSON.stringify({ status: "cancelled" }),
    });
  }
}

module.exports = { WooCommerceClient, WooCommerceSettings, httpsUrl };
