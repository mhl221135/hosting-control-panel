const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  enabled: false,
  intervalMinutes: 5,
  maxSnapshotAgeSeconds: 300,
};

const STATES = new Set(["active", "reminder", "grace", "suspended", "exempt"]);
const MODES = new Set(["none", "reminder", "manual", "payment_page"]);

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function integer(value, minimum, maximum, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw validationError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function settings(payload = {}) {
  return {
    enabled: Boolean(payload.enabled),
    intervalMinutes: integer(payload.intervalMinutes ?? DEFAULTS.intervalMinutes, 1, 60, "intervalMinutes"),
    maxSnapshotAgeSeconds: integer(
      payload.maxSnapshotAgeSeconds ?? DEFAULTS.maxSnapshotAgeSeconds,
      30,
      1800,
      "maxSnapshotAgeSeconds",
    ),
  };
}

function secureEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validDomain(value) {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function validatePayload(document, token, maxAgeSeconds, now = Date.now()) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw validationError("Billing entitlement response must be an object");
  }
  const { signature, ...payload } = document;
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(signature || ""))) {
    throw validationError("Billing entitlement signature is malformed");
  }
  const expected = crypto.createHmac("sha256", token).update(JSON.stringify(payload)).digest("base64url");
  if (!secureEqual(signature, expected)) {
    throw Object.assign(new Error("Billing entitlement signature verification failed"), { statusCode: 502 });
  }
  if (payload.version !== 1 || !Array.isArray(payload.services) || payload.services.length > 10000) {
    throw validationError("Billing entitlement payload contract is unsupported");
  }
  const generatedMs = Date.parse(payload.generatedAt);
  const ageSeconds = Math.floor((now - generatedMs) / 1000);
  if (!Number.isFinite(generatedMs) || ageSeconds < -60 || ageSeconds > maxAgeSeconds) {
    throw Object.assign(new Error("Billing entitlement snapshot is stale"), { statusCode: 503 });
  }
  const serviceIds = new Set();
  const domainOwners = new Map();
  const services = payload.services.map((service) => {
    const normalized = {
      serviceId: String(service?.serviceId || ""),
      primaryDomain: String(service?.primaryDomain || "").toLowerCase(),
      aliases: Array.isArray(service?.aliases) ? service.aliases.map((item) => String(item).toLowerCase()) : [],
      state: String(service?.state || ""),
      paidThrough: String(service?.paidThrough || ""),
      graceDays: Number(service?.graceDays),
      enforcementMode: String(service?.enforcementMode || ""),
      renewalUrl: String(service?.renewalUrl || ""),
    };
    if (!/^[a-z0-9][a-z0-9_-]{5,79}$/.test(normalized.serviceId) || serviceIds.has(normalized.serviceId)) {
      throw validationError("Billing entitlement service ID is invalid or duplicated");
    }
    if (!validDomain(normalized.primaryDomain) || normalized.aliases.some((domain) => !validDomain(domain))) {
      throw validationError("Billing entitlement contains an invalid domain");
    }
    if (!STATES.has(normalized.state) || !MODES.has(normalized.enforcementMode)) {
      throw validationError("Billing entitlement state or enforcement mode is unsupported");
    }
    if (normalized.renewalUrl) {
      let parsed;
      try {
        parsed = new URL(normalized.renewalUrl);
      } catch {
        throw validationError("Billing entitlement renewal URL is invalid");
      }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password
        || parsed.href.length > 2048 || !/^\/renew\/[A-Za-z0-9_-]+$/.test(parsed.pathname)) {
        throw validationError("Billing entitlement renewal URL is invalid");
      }
      normalized.renewalUrl = parsed.href;
    }
    if (!/^(?:|\d{4}-\d{2}-\d{2})$/.test(normalized.paidThrough)
      || (!normalized.paidThrough && normalized.state !== "exempt")
      || !Number.isInteger(normalized.graceDays)
      || normalized.graceDays < 0
      || normalized.graceDays > 365) {
      throw validationError("Billing entitlement renewal policy is invalid");
    }
    serviceIds.add(normalized.serviceId);
    for (const domain of [normalized.primaryDomain, ...normalized.aliases]) {
      if (domainOwners.has(domain) && domainOwners.get(domain) !== normalized.serviceId) {
        throw validationError("Billing entitlement domain ownership is ambiguous");
      }
      domainOwners.set(domain, normalized.serviceId);
    }
    return normalized;
  });
  return {
    payload,
    services,
    signature,
    ageSeconds: Math.max(0, ageSeconds),
  };
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

class BillingEntitlementObserver {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    this.apiUrl = String(options.apiUrl || process.env.BILLING_API_URL || "").replace(/\/+$/, "");
    this.token = String(options.token || process.env.BILLING_API_TOKEN || "");
    this.siteProvider = options.siteProvider || (async () => []);
    this.fetch = options.fetch || global.fetch;
    this.now = options.now || (() => Date.now());
    this.settingsPath = path.join(this.dataDir, "billing-observer-settings.json");
    this.snapshotPath = path.join(this.dataDir, "billing-entitlements-lkg.json");
    this.timer = null;
    this.lastAttemptAt = null;
    this.lastError = "";
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  configured() {
    return /^https?:\/\//.test(this.apiUrl) && this.token.length >= 32 && typeof this.fetch === "function";
  }

  readSettings() {
    try {
      return settings({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.settingsPath, "utf8")) });
    } catch (error) {
      if (error.statusCode) throw error;
      return { ...DEFAULTS };
    }
  }

  saveSettings(payload) {
    const value = settings(payload);
    atomicJson(this.settingsPath, { ...value, updatedAt: new Date(this.now()).toISOString() });
    this.schedule();
    return value;
  }

  readSnapshot() {
    try {
      return JSON.parse(fs.readFileSync(this.snapshotPath, "utf8"));
    } catch {
      return null;
    }
  }

  async view() {
    const configured = this.configured();
    const configuredSettings = this.readSettings();
    const snapshot = this.readSnapshot();
    const generatedMs = snapshot ? Date.parse(snapshot.payload?.generatedAt) : NaN;
    const ageSeconds = Number.isFinite(generatedMs) ? Math.max(0, Math.floor((this.now() - generatedMs) / 1000)) : null;
    return {
      mode: "observe-only",
      enforcementEnabled: false,
      configured,
      settings: configuredSettings,
      lastAttemptAt: this.lastAttemptAt,
      lastError: this.lastError,
      snapshot: snapshot ? {
        observedAt: snapshot.observedAt,
        generatedAt: snapshot.payload?.generatedAt,
        ageSeconds,
        fresh: ageSeconds !== null && ageSeconds <= configuredSettings.maxSnapshotAgeSeconds,
        serviceCount: snapshot.payload?.services?.length || 0,
        matches: snapshot.matches || [],
        unmatchedLocal: snapshot.unmatchedLocal || [],
        unmatchedBilling: snapshot.unmatchedBilling || [],
      } : null,
    };
  }

  async refresh() {
    this.lastAttemptAt = new Date(this.now()).toISOString();
    if (!this.configured()) {
      this.lastError = "Billing observer is not configured";
      throw Object.assign(new Error(this.lastError), { statusCode: 503 });
    }
    const configuredSettings = this.readSettings();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetch(`${this.apiUrl}/entitlements`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw Object.assign(new Error(`Billing API returned HTTP ${response.status}`), { statusCode: 502 });
      const document = await response.json();
      const verified = validatePayload(document, this.token, configuredSettings.maxSnapshotAgeSeconds, this.now());
      const sites = await this.siteProvider();
      const localDomains = new Set(sites.filter((site) => !site.isAlias).map((site) => String(site.host || "").toLowerCase()));
      const matches = [];
      const matchedLocal = new Set();
      const unmatchedBilling = [];
      for (const service of verified.services) {
        const candidates = [service.primaryDomain, ...service.aliases];
        const localDomain = candidates.find((domain) => localDomains.has(domain));
        if (localDomain) {
          matchedLocal.add(localDomain);
          matches.push({ ...service, localDomain, action: "none" });
        } else {
          unmatchedBilling.push({ serviceId: service.serviceId, primaryDomain: service.primaryDomain, state: service.state });
        }
      }
      const snapshot = {
        observedAt: this.lastAttemptAt,
        payload: verified.payload,
        signature: verified.signature,
        matches,
        unmatchedLocal: [...localDomains].filter((domain) => !matchedLocal.has(domain)).sort(),
        unmatchedBilling,
      };
      atomicJson(this.snapshotPath, snapshot);
      this.lastError = "";
      return this.view();
    } catch (error) {
      this.lastError = error.name === "AbortError" ? "Billing API request timed out" : error.message;
      throw Object.assign(new Error(this.lastError), { statusCode: error.statusCode || 502 });
    } finally {
      clearTimeout(timeout);
    }
  }

  schedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const configuredSettings = this.readSettings();
    if (!configuredSettings.enabled) return;
    this.timer = setInterval(() => {
      this.refresh().catch((error) => console.error(`Billing entitlement observation failed: ${error.message}`));
    }, configuredSettings.intervalMinutes * 60_000);
    this.timer.unref?.();
  }

  start() {
    this.schedule();
    if (this.readSettings().enabled) {
      setTimeout(() => this.refresh().catch((error) => {
        console.error(`Initial billing entitlement observation failed: ${error.message}`);
      }), 10_000).unref?.();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { BillingEntitlementObserver, DEFAULTS, settings, validatePayload };
