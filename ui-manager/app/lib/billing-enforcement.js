const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  enabled: false,
  pilotDomains: [],
};

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function validDomain(value) {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function normalizeSettings(input = {}) {
  const values = Array.isArray(input.pilotDomains)
    ? input.pilotDomains
    : String(input.pilotDomains || "").split(/[\s,;]+/);
  const pilotDomains = [...new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  if (pilotDomains.length > 100 || pilotDomains.some((domain) => !validDomain(domain))) {
    throw validationError("Pilot domains must contain at most 100 valid website hostnames");
  }
  return {
    enabled: input.enabled === true,
    pilotDomains: pilotDomains.sort(),
  };
}

function validRenewalUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && parsed.href.length <= 2048
      && /^\/renew\/[A-Za-z0-9_-]+$/.test(parsed.pathname)
      ? parsed.href
      : "";
  } catch {
    return "";
  }
}

function atomicWrite(filePath, content, mode = 0o644) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
  fs.renameSync(temporary, filePath);
}

function renderMap(entries = {}) {
  const lines = ["map $host $billing_renewal_url {", '  default "";'];
  for (const domain of Object.keys(entries).sort()) {
    const renewalUrl = validRenewalUrl(entries[domain]);
    if (!validDomain(domain) || !renewalUrl) throw new Error("Refusing to render an invalid billing enforcement entry");
    lines.push(`  ${domain} ${JSON.stringify(renewalUrl)};`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

function ensureNginxIntegration(content) {
  let updated = String(content);
  if (!updated.includes("include /etc/nginx/conf.d/billing-enforcement.map;")) {
    const marker = "include /etc/nginx/conf.d/cache.map;";
    if (!updated.includes(marker)) throw new Error("Nginx cache map include was not found");
    updated = updated.replace(marker, `${marker}\ninclude /etc/nginx/conf.d/billing-enforcement.map;`);
  }
  if (!updated.includes("# Managed billing enforcement.")) {
    const marker = "    # Managed sensitive-file protection.";
    if (!updated.includes(marker)) throw new Error("Nginx security marker was not found");
    updated = updated.replace(marker, [
      "    # Managed billing enforcement.",
      '    if ($billing_renewal_url != "") {',
      "        return 302 $billing_renewal_url;",
      "    }",
      "",
      marker,
    ].join("\n"));
  }
  return updated;
}

function buildPlan(observer, sites, configuredSettings) {
  const settings = normalizeSettings(configuredSettings);
  const snapshot = observer?.snapshot || null;
  const localSites = new Map(
    sites.filter((site) => !site.isAlias).map((site) => [String(site.host).toLowerCase(), site]),
  );
  const entries = {};
  const rows = [];
  for (const match of snapshot?.matches || []) {
    const localDomain = String(match.localDomain || "").toLowerCase();
    const site = localSites.get(localDomain);
    const renewalUrl = validRenewalUrl(match.renewalUrl);
    let action = "none";
    let reason = "Billing policy does not require blocking";
    if (!settings.enabled) reason = "Global enforcement is disabled";
    else if (!snapshot.fresh) reason = "Signed entitlement snapshot is stale";
    else if (!settings.pilotDomains.includes(localDomain)) reason = "Website is not in the pilot allowlist";
    else if (match.enforcementMode !== "payment_page") reason = "Service policy is not payment_page";
    else if (match.state !== "suspended") reason = `Billing state is ${match.state}`;
    else if (!renewalUrl) reason = "Signed renewal URL is unavailable or invalid";
    else if (!site) reason = "Local website mapping is unavailable";
    else {
      action = "block";
      reason = "Fresh signed suspended entitlement";
      const approved = new Set([match.primaryDomain, ...(match.aliases || [])]);
      const hosts = [localDomain, ...(site.aliases || [])]
        .map((domain) => String(domain).toLowerCase())
        .filter((domain) => approved.has(domain));
      for (const domain of hosts) entries[domain] = renewalUrl;
    }
    rows.push({
      serviceId: match.serviceId,
      localDomain,
      state: match.state,
      enforcementMode: match.enforcementMode,
      action,
      reason,
    });
  }
  return {
    entries,
    rows,
    blockedHosts: Object.keys(entries).sort(),
    safeToApply: !settings.enabled || Boolean(snapshot?.fresh),
    reason: !settings.enabled
      ? "Global enforcement is disabled"
      : snapshot?.fresh ? "Fresh signed snapshot verified" : "No fresh signed snapshot; fail-open map required",
  };
}

class BillingEnforcementManager {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    this.mapPath = options.mapPath;
    this.nginxDefaultPath = options.nginxDefaultPath;
    this.observer = options.observer;
    this.siteProvider = options.siteProvider || (async () => []);
    this.validateReload = options.validateReload || (async () => {});
    this.now = options.now || (() => Date.now());
    this.settingsPath = path.join(this.dataDir, "billing-enforcement-settings.json");
    this.statusPath = path.join(this.dataDir, "billing-enforcement-status.json");
    this.timer = null;
    this.running = false;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  readSettings() {
    try {
      return normalizeSettings({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.settingsPath, "utf8")) });
    } catch (error) {
      if (error.statusCode) throw error;
      return { ...DEFAULTS };
    }
  }

  saveSettings(input) {
    const settings = normalizeSettings(input);
    atomicWrite(this.settingsPath, JSON.stringify({
      ...settings,
      updatedAt: new Date(this.now()).toISOString(),
    }, null, 2), 0o600);
    return settings;
  }

  readStatus() {
    try {
      return JSON.parse(fs.readFileSync(this.statusPath, "utf8"));
    } catch {
      return { appliedAt: "", blockedHosts: [], result: "not-applied", error: "" };
    }
  }

  prepare() {
    if (!fs.existsSync(this.mapPath)) atomicWrite(this.mapPath, renderMap());
    const current = fs.readFileSync(this.nginxDefaultPath, "utf8");
    const updated = ensureNginxIntegration(current);
    if (updated !== current) atomicWrite(this.nginxDefaultPath, updated);
    return updated !== current;
  }

  async preview() {
    return buildPlan(await this.observer.view(), await this.siteProvider(), this.readSettings());
  }

  record(result) {
    atomicWrite(this.statusPath, JSON.stringify({
      ...result,
      appliedAt: new Date(this.now()).toISOString(),
    }, null, 2), 0o600);
  }

  async applyPlan(plan, actor, action = "reconcile") {
    const previous = fs.existsSync(this.mapPath) ? fs.readFileSync(this.mapPath, "utf8") : renderMap();
    const candidate = renderMap(plan.entries);
    try {
      if (candidate !== previous) {
        atomicWrite(this.mapPath, candidate);
        await this.validateReload();
      }
      const result = {
        result: "applied",
        action,
        actor: String(actor || "system").slice(0, 160),
        blockedHosts: plan.blockedHosts,
        error: "",
      };
      this.record(result);
      return { ...result, plan };
    } catch (error) {
      atomicWrite(this.mapPath, previous);
      try {
        await this.validateReload();
      } catch {}
      const result = {
        result: "failed",
        action,
        actor: String(actor || "system").slice(0, 160),
        blockedHosts: [],
        error: String(error.message || error).slice(0, 300),
      };
      this.record(result);
      throw Object.assign(new Error("Billing enforcement validation failed; previous map restored"), {
        statusCode: 500,
        details: result.error,
      });
    }
  }

  async reconcile(actor = "system") {
    if (this.running) throw Object.assign(new Error("Billing enforcement reconciliation is already running"), {
      statusCode: 409,
    });
    this.running = true;
    try {
      let plan;
      try {
        plan = await this.preview();
      } catch (error) {
        plan = {
          entries: {},
          rows: [],
          blockedHosts: [],
          safeToApply: true,
          reason: `Observer unavailable; fail open: ${String(error.message).slice(0, 200)}`,
        };
      }
      return this.applyPlan(plan, actor);
    } finally {
      this.running = false;
    }
  }

  async updateSettings(input, actor) {
    const settings = this.saveSettings(input);
    if (!settings.enabled) await this.applyPlan(buildPlan(null, [], settings), actor, "disable");
    return this.view();
  }

  async disableAll(actor) {
    const settings = this.saveSettings({ ...this.readSettings(), enabled: false });
    const plan = buildPlan(null, [], settings);
    return this.applyPlan(plan, actor, "disable-all");
  }

  async view() {
    return {
      settings: this.readSettings(),
      status: this.readStatus(),
      running: this.running,
      plan: await this.preview(),
    };
  }

  start() {
    let integrationChanged = false;
    try {
      integrationChanged = this.prepare();
    } catch (error) {
      this.record({
        result: "failed",
        action: "prepare",
        actor: "startup",
        blockedHosts: [],
        error: String(error.message || error).slice(0, 300),
      });
      console.error(`Billing enforcement integration is unavailable: ${error.message}`);
      return;
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.readSettings().enabled) return;
      this.reconcile("scheduler").catch((error) => {
        console.error(`Billing enforcement reconciliation failed: ${error.message}`);
      });
    }, 60_000);
    this.timer.unref?.();
    setTimeout(async () => {
      try {
        if (integrationChanged) await this.validateReload();
        await this.reconcile("startup");
      } catch (error) {
        console.error(`Initial billing enforcement reconciliation failed: ${error.message}`);
      }
    }, 12_000).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  BillingEnforcementManager,
  DEFAULTS,
  buildPlan,
  ensureNginxIntegration,
  normalizeSettings,
  renderMap,
  validRenewalUrl,
};
