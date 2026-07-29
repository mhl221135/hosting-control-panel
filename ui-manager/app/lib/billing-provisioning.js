const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  enabled: false,
  freeMonths: 6,
  renewalMonths: 12,
  hostingPriceMinor: 8000,
  domainRenewalMonths: 12,
  currency: "USD",
  graceDays: 7,
  timezone: "Europe/Kyiv",
};

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function integer(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw validationError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function normalize(input = {}) {
  const currency = String(input.currency || DEFAULTS.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw validationError("Billing currency must be a three-letter code");
  const timezone = String(input.timezone || DEFAULTS.timezone).trim().slice(0, 80);
  if (!timezone) throw validationError("Billing timezone is required");
  return {
    enabled: input.enabled === true,
    freeMonths: integer(input.freeMonths ?? DEFAULTS.freeMonths, 0, 60, "Free months"),
    renewalMonths: integer(input.renewalMonths ?? DEFAULTS.renewalMonths, 1, 120, "Renewal months"),
    hostingPriceMinor: integer(input.hostingPriceMinor ?? DEFAULTS.hostingPriceMinor, 0, 10_000_000_000, "Hosting price"),
    domainRenewalMonths: integer(
      input.domainRenewalMonths ?? DEFAULTS.domainRenewalMonths,
      1,
      120,
      "Domain renewal months",
    ),
    currency,
    graceDays: integer(input.graceDays ?? DEFAULTS.graceDays, 0, 365, "Grace days"),
    timezone,
  };
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

class BillingProvisioningSettings {
  constructor(dataDir) {
    this.file = path.join(dataDir, "billing-provisioning-settings.json");
    fs.mkdirSync(dataDir, { recursive: true });
  }

  read() {
    try {
      return normalize({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file, "utf8")) });
    } catch (error) {
      if (error.statusCode) throw error;
      return { ...DEFAULTS };
    }
  }

  update(input) {
    const value = normalize(input);
    atomicJson(this.file, { ...value, updatedAt: new Date().toISOString() });
    return value;
  }

  registration(body = {}) {
    const defaults = this.read();
    const currency = String(body.billing_currency || defaults.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw validationError("Billing currency must be a three-letter code");
    return {
      enabled: body.register_billing === true,
      grantFreePeriod: body.billing_grant_free_period === true,
      freeMonths: integer(body.billing_free_months ?? defaults.freeMonths, 0, 60, "Free months"),
      renewalMonths: integer(body.billing_renewal_months ?? defaults.renewalMonths, 1, 120, "Renewal months"),
      hostingPriceMinor: integer(
        Math.round(Number(body.billing_hosting_price ?? defaults.hostingPriceMinor / 100) * 100),
        0,
        10_000_000_000,
        "Hosting price",
      ),
      domainRenewalMonths: integer(
        body.billing_domain_renewal_months ?? defaults.domainRenewalMonths,
        1,
        120,
        "Domain renewal months",
      ),
      domainPriceMinor: integer(
        Math.round(Number(body.billing_domain_price || 0) * 100),
        0,
        10_000_000_000,
        "Domain price",
      ),
      domainPaidThrough: String(body.billing_domain_paid_through || ""),
      currency,
      graceDays: integer(body.billing_grace_days ?? defaults.graceDays, 0, 365, "Grace days"),
      timezone: defaults.timezone,
      customerName: String(body.billing_customer_name || "").trim().slice(0, 200),
      contactEmail: String(body.billing_contact_email || "").trim().toLowerCase().slice(0, 254),
    };
  }
}

class BillingProvisioningClient {
  constructor(options = {}) {
    this.apiUrl = String(options.apiUrl || "").replace(/\/+$/, "");
    this.token = String(options.token || "");
    this.fetch = options.fetch || global.fetch;
  }

  configured() {
    return /^https?:\/\//.test(this.apiUrl) && this.token.length >= 32 && typeof this.fetch === "function";
  }

  async register(payload, idempotencyKey) {
    if (!this.configured()) throw Object.assign(new Error("Billing registration is not configured"), { statusCode: 503 });
    const response = await this.fetch(`${this.apiUrl}/services`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(`Billing registration failed with HTTP ${response.status}`), {
        statusCode: 502,
        details: String(result.message || "").slice(0, 300),
      });
    }
    if (!result?.service?.serviceId || result.service.primaryDomain !== payload.primary_domain) {
      throw new Error("Billing registration returned an invalid service");
    }
    return result;
  }
}

module.exports = {
  BillingProvisioningClient,
  BillingProvisioningSettings,
  DEFAULTS,
  normalize,
};
