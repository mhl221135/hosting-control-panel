const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");

const BULK_PRESETS = {
  "wordpress-login": {
    label: "WordPress login protection",
    wordpressOnly: true,
    operations: [{ kind: "rule", preset: "login-rate-limit" }],
  },
  "xmlrpc-block": {
    label: "Block WordPress XML-RPC",
    wordpressOnly: true,
    operations: [{ kind: "rule", preset: "xmlrpc-block" }],
  },
  "sensitive-files": {
    label: "Block sensitive-file probes",
    operations: [{ kind: "rule", preset: "suspicious-probes" }],
  },
  "security-baseline": {
    label: "Conservative security baseline",
    operations: [
      { kind: "setting", setting: "security_level", value: "medium" },
      { kind: "setting", setting: "browser_check", value: "on" },
      { kind: "setting", setting: "challenge_ttl", value: 1800 },
    ],
  },
  "cache-baseline": {
    label: "Conservative cache baseline",
    operations: [
      { kind: "setting", setting: "cache_level", value: "basic" },
      { kind: "setting", setting: "browser_cache_ttl", value: 14400 },
    ],
  },
  "always-online": {
    label: "Always Online",
    warning: "Archived static pages may be served when the origin is unavailable; carts, comments, logins, and other dynamic behavior are not preserved.",
    operations: [{ kind: "setting", setting: "always_online", value: "on" }],
  },
};

const INCIDENT_ACTIONS = new Set(["managed_challenge", "block", "purge_cache"]);
const INCIDENT_DURATIONS = new Set([600, 3600, 86400, 604800]);
const DEFAULT_SETTINGS = {
  provisioningDefaultsEnabled: false,
  provisioningPresets: ["sensitive-files", "security-baseline"],
  protectedAddresses: [],
};

function atomicJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function boundedText(value, maximum = 500) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum);
}

function addressList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/);
  const addresses = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
  for (const address of addresses) {
    if (!net.isIP(address)) {
      throw Object.assign(new Error(`Protected address is invalid: ${address}`), { statusCode: 400 });
    }
  }
  return addresses;
}

function addSubnet(blocklist, cidr) {
  const [address, prefixText] = String(cidr).split("/");
  const family = net.isIP(address);
  const prefix = Number(prefixText);
  if (!family || !Number.isInteger(prefix)) return;
  blocklist.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
}

function reservedBlockList() {
  const blocklist = new net.BlockList();
  for (const cidr of [
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
    "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
    "::/128", "::1/128", "fc00::/7", "fe80::/10", "2001:db8::/32", "ff00::/8",
  ]) addSubnet(blocklist, cidr);
  return blocklist;
}

function publicPresetView() {
  return Object.entries(BULK_PRESETS).map(([id, preset]) => ({
    id,
    label: preset.label,
    wordpressOnly: Boolean(preset.wordpressOnly),
    warning: preset.warning || "",
  }));
}

class CloudflareAutomationManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.client = options.client;
    this.jobManager = options.jobManager;
    this.siteProvider = options.siteProvider;
    this.serverAddresses = options.serverAddresses || (() => []);
    this.proxyRangesProvider = options.proxyRangesProvider || this.fetchProxyRanges.bind(this);
    this.settingsPath = path.join(this.dataDir, "cloudflare-automation-settings.json");
    this.historyPath = path.join(this.dataDir, "cloudflare-automation-history.json");
    this.incidentsPath = path.join(this.dataDir, "cloudflare-incidents.json");
    this.proxyRangesCache = null;
    this.timer = null;
    this.recoverInterruptedBatches();
    this.registerJobs();
  }

  registerJobs() {
    this.jobManager.register("cloudflare.bulk-apply", (context, payload) =>
      this.applyBulk(payload, context));
    this.jobManager.register("cloudflare.bulk-rollback", (context, payload) =>
      this.rollbackBulk(payload.batchId, context));
    this.jobManager.register("cloudflare.incident-apply", (context, payload) =>
      this.applyIncident(payload, context));
    this.jobManager.register("cloudflare.incident-remove", (context, payload) =>
      this.removeIncident(payload.mitigationId, context));
  }

  readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  settings() {
    return { ...DEFAULT_SETTINGS, ...this.readJson(this.settingsPath, {}) };
  }

  updateSettings(payload) {
    const current = this.settings();
    const presets = payload.provisioningPresets === undefined
      ? current.provisioningPresets
      : [...new Set((payload.provisioningPresets || []).map(String))];
    for (const preset of presets) {
      if (!BULK_PRESETS[preset]) {
        throw Object.assign(new Error(`Unknown Cloudflare preset: ${preset}`), { statusCode: 400 });
      }
    }
    const next = {
      provisioningDefaultsEnabled: payload.provisioningDefaultsEnabled === undefined
        ? current.provisioningDefaultsEnabled
        : payload.provisioningDefaultsEnabled === true,
      provisioningPresets: presets,
      protectedAddresses: payload.protectedAddresses === undefined
        ? current.protectedAddresses
        : addressList(payload.protectedAddresses),
      updatedAt: new Date().toISOString(),
    };
    atomicJson(this.settingsPath, next);
    return next;
  }

  publicView() {
    return {
      settings: this.settings(),
      presets: publicPresetView(),
      batches: this.history().slice(0, 20).map((batch) => ({
        id: batch.id,
        createdAt: batch.createdAt,
        operator: batch.operator,
        status: batch.status,
        total: batch.total,
        changed: batch.changed,
        failed: batch.failed,
        rolledBackAt: batch.rolledBackAt || "",
      })),
      incidents: this.incidents().slice(0, 100).map((incident) => ({
        id: incident.id,
        domain: incident.domain,
        address: incident.address,
        action: incident.action,
        createdAt: incident.createdAt,
        expiresAt: incident.expiresAt,
        removedAt: incident.removedAt || "",
        status: incident.removedAt ? "removed" : Date.parse(incident.expiresAt) <= Date.now() ? "expired" : "active",
      })),
    };
  }

  provisioningSelection(siteType, optedIn) {
    if (!optedIn || !this.settings().provisioningDefaultsEnabled) return [];
    return this.settings().provisioningPresets.filter((presetId) =>
      BULK_PRESETS[presetId] && (!BULK_PRESETS[presetId].wordpressOnly || siteType === "wordpress"));
  }

  async applyProvisioningDefaults(domain, siteType, optedIn) {
    const presets = this.provisioningSelection(siteType, optedIn);
    const steps = [];
    const appliedSettings = new Set();
    for (const presetId of presets) {
      const preset = BULK_PRESETS[presetId];
      for (const operation of preset.operations) {
        try {
          if (operation.kind === "rule") {
            const result = await this.client.applySecurityPreset(domain, operation.preset);
            steps.push({
              name: "cloudflare-default",
              status: "complete",
              preset: presetId,
              changed: Boolean(result.created || result.updated),
            });
          } else if (!appliedSettings.has(operation.setting)) {
            appliedSettings.add(operation.setting);
            const current = await this.client.zoneSetting(domain, operation.setting);
            if (!current.editable) throw new Error(`${operation.setting} is not editable on this zone or plan`);
            if (current.value !== operation.value) {
              await this.client.setZoneSetting(domain, operation.setting, operation.value);
            }
            steps.push({
              name: "cloudflare-default",
              status: "complete",
              preset: presetId,
              setting: operation.setting,
              changed: current.value !== operation.value,
            });
          }
        } catch (error) {
          steps.push({
            name: "cloudflare-default",
            status: "warning",
            preset: presetId,
            message: boundedText(error.message),
          });
        }
      }
    }
    return steps;
  }

  history() {
    const value = this.readJson(this.historyPath, { batches: [] });
    return Array.isArray(value.batches) ? value.batches : [];
  }

  saveHistory(batches) {
    atomicJson(this.historyPath, { version: 1, batches: batches.slice(0, 100) });
  }

  recoverInterruptedBatches() {
    const batches = this.history();
    let changed = false;
    for (const batch of batches) {
      if (batch.status !== "running") continue;
      batch.status = "interrupted";
      batch.finishedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) this.saveHistory(batches);
  }

  incidents() {
    const value = this.readJson(this.incidentsPath, { incidents: [] });
    return Array.isArray(value.incidents) ? value.incidents : [];
  }

  saveIncidents(incidents) {
    atomicJson(this.incidentsPath, { version: 1, incidents: incidents.slice(0, 500) });
  }

  async sitesForDomains(domains) {
    const requested = [...new Set((domains || []).map(String))];
    if (!requested.length || requested.length > 250) {
      throw Object.assign(new Error("Select between 1 and 250 primary websites"), { statusCode: 400 });
    }
    const sites = (await this.siteProvider()).filter((site) => !site.isAlias && !site.isWwwAlias);
    return requested.map((domain) => {
      const site = sites.find((item) => item.host === domain);
      if (!site) throw Object.assign(new Error(`Primary website is not configured: ${domain}`), { statusCode: 404 });
      return site;
    });
  }

  validatePresets(presets) {
    const selected = [...new Set((presets || []).map(String))];
    if (!selected.length) throw Object.assign(new Error("Select at least one Cloudflare preset"), { statusCode: 400 });
    for (const preset of selected) {
      if (!BULK_PRESETS[preset]) {
        throw Object.assign(new Error(`Unknown Cloudflare preset: ${preset}`), { statusCode: 400 });
      }
    }
    return selected;
  }

  previewHash(preview) {
    const stable = preview.operations.map((operation) => ({
      domain: operation.domain,
      zone: operation.zone,
      preset: operation.preset,
      kind: operation.kind,
      setting: operation.setting || "",
      change: operation.change,
      current: operation.current,
      desired: operation.desired,
      error: operation.error || "",
    }));
    return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
  }

  async previewBulk(domains, presets) {
    const sites = await this.sitesForDomains(domains);
    const selected = this.validatePresets(presets);
    const operations = [];
    const settingZones = new Set();
    for (const site of sites) {
      for (const presetId of selected) {
        const preset = BULK_PRESETS[presetId];
        if (preset.wordpressOnly && site.state?.siteType !== "wordpress") {
          operations.push({
            domain: site.host,
            zone: "",
            preset: presetId,
            kind: "compatibility",
            change: "error",
            current: "",
            desired: "",
            error: "Preset requires WordPress",
          });
          continue;
        }
        for (const definition of preset.operations) {
          try {
            if (definition.kind === "rule") {
              const desired = this.client.securityPreset(site.host, definition.preset);
              const preview = await this.client.previewPanelRule(site.host, desired);
              operations.push({
                domain: site.host,
                zone: preview.zone.name,
                zoneId: preview.zone.id,
                preset: presetId,
                kind: "rule",
                sourcePreset: definition.preset,
                change: preview.change,
                current: preview.existing ? {
                  action: preview.existing.action,
                  enabled: preview.existing.enabled !== false,
                  expression: preview.existing.expression,
                } : null,
                desired: {
                  action: desired.rule.action,
                  enabled: true,
                  expression: desired.rule.expression,
                },
              });
            } else {
              const current = await this.client.zoneSetting(site.host, definition.setting);
              const dedupe = `${current.zone.id}:${definition.setting}`;
              if (settingZones.has(dedupe)) continue;
              settingZones.add(dedupe);
              operations.push({
                domain: site.host,
                zone: current.zone.name,
                zoneId: current.zone.id,
                preset: presetId,
                kind: "setting",
                setting: definition.setting,
                change: current.value === definition.value ? "none" : current.editable ? "update" : "error",
                current: current.value,
                desired: definition.value,
                error: current.editable ? "" : "Setting is not editable on this zone or plan",
              });
            }
          } catch (error) {
            operations.push({
              domain: site.host,
              zone: "",
              preset: presetId,
              kind: definition.kind,
              setting: definition.setting || "",
              change: "error",
              current: "",
              desired: definition.value ?? "",
              error: boundedText(error.message),
            });
          }
        }
      }
    }
    const preview = {
      domains: sites.map((site) => site.host),
      presets: selected,
      operations,
      totals: {
        changes: operations.filter((item) => ["create", "update"].includes(item.change)).length,
        unchanged: operations.filter((item) => item.change === "none").length,
        errors: operations.filter((item) => item.change === "error").length,
      },
      warnings: selected.includes("always-online") ? [BULK_PRESETS["always-online"].warning] : [],
    };
    preview.id = this.previewHash(preview);
    return preview;
  }

  bulkJob(input, operator) {
    return this.jobManager.create({
      type: "cloudflare.bulk-apply",
      label: `Apply Cloudflare presets to ${input.domains.length} website${input.domains.length === 1 ? "" : "s"}`,
      operator,
      trigger: "manual",
      payload: {
        domains: input.domains,
        presets: input.presets,
        previewId: input.previewId,
        operator,
      },
      targets: input.domains,
      conflicts: ["cloudflare-automation", ...input.domains.map((domain) => `cloudflare:${domain}`)],
      total: input.domains.length * input.presets.length,
      cancellable: true,
      retryable: true,
    });
  }

  rollbackJob(batchId, operator) {
    const batch = this.history().find((item) => item.id === batchId);
    if (!batch) throw Object.assign(new Error("Cloudflare automation batch was not found"), { statusCode: 404 });
    if (batch.rolledBackAt) throw Object.assign(new Error("Cloudflare automation batch was already rolled back"), {
      statusCode: 409,
    });
    return this.jobManager.create({
      type: "cloudflare.bulk-rollback",
      label: "Rollback Cloudflare automation batch",
      operator,
      trigger: "manual",
      payload: { batchId },
      targets: batch.domains,
      conflicts: ["cloudflare-automation", ...batch.domains.map((domain) => `cloudflare:${domain}`)],
      total: batch.rollback.length,
      cancellable: true,
      retryable: false,
    });
  }

  async applyBulk(payload, context) {
    const preview = await this.previewBulk(payload.domains, payload.presets);
    if (preview.id !== payload.previewId) {
      throw Object.assign(new Error("Cloudflare state changed after preview; refresh the dry run"), { statusCode: 409 });
    }
    if (preview.totals.errors) {
      throw Object.assign(new Error("Dry run contains entitlement, permission, or compatibility errors"), {
        statusCode: 409,
      });
    }
    const batch = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      operator: boundedText(payload.operator, 160),
      status: "running",
      domains: preview.domains,
      presets: preview.presets,
      total: preview.operations.length,
      changed: 0,
      failed: 0,
      results: [],
      rollback: [],
    };
    const batches = this.history();
    batches.unshift(batch);
    this.saveHistory(batches);
    context.update({ total: preview.operations.length, completed: 0, currentStep: "Applying Cloudflare presets" });
    for (const operation of preview.operations) {
      context.checkpoint();
      if (operation.change === "none") {
        batch.results.push({ ...operation, ok: true, status: "unchanged" });
      } else {
        try {
          if (operation.kind === "rule") {
            const applied = await this.client.applySecurityPreset(operation.domain, operation.sourcePreset);
            batch.rollback.push({
              kind: "rule",
              domain: operation.domain,
              rulesetId: applied.rulesetId,
              ruleId: applied.rule?.id,
              mode: applied.created ? "delete" : "restore",
              previous: applied.previous || null,
            });
          } else {
            await this.client.setZoneSetting(operation.domain, operation.setting, operation.desired);
            batch.rollback.push({
              kind: "setting",
              domain: operation.domain,
              setting: operation.setting,
              previous: operation.current,
            });
          }
          batch.changed += 1;
          batch.results.push({ ...operation, ok: true, status: "changed" });
        } catch (error) {
          batch.failed += 1;
          batch.results.push({ ...operation, ok: false, status: "failed", error: boundedText(error.message) });
        }
      }
      context.update({
        completed: batch.results.length,
        currentStep: `${operation.zone || operation.domain}: ${BULK_PRESETS[operation.preset]?.label || operation.preset}`,
        results: batch.results,
      });
    }
    batch.status = batch.failed ? (batch.changed ? "partial" : "failed") : "complete";
    batch.finishedAt = new Date().toISOString();
    this.saveHistory(batches);
    return {
      ok: batch.failed === 0,
      total: batch.total,
      completed: batch.results.length,
      results: batch.results,
      batchId: batch.id,
      message: batch.failed ? "Cloudflare automation completed with failures" : "Cloudflare automation completed",
    };
  }

  async rollbackBulk(batchId, context) {
    const batches = this.history();
    const batch = batches.find((item) => item.id === batchId);
    if (!batch) throw Object.assign(new Error("Cloudflare automation batch was not found"), { statusCode: 404 });
    if (batch.rolledBackAt) throw Object.assign(new Error("Cloudflare automation batch was already rolled back"), {
      statusCode: 409,
    });
    const results = [];
    const rollback = [...batch.rollback].reverse();
    context.update({ total: rollback.length, completed: 0, currentStep: "Rolling back panel-managed changes" });
    for (const operation of rollback) {
      context.checkpoint();
      try {
        if (operation.kind === "setting") {
          await this.client.setZoneSetting(operation.domain, operation.setting, operation.previous);
        } else if (operation.mode === "delete") {
          await this.client.deleteSecurityRule(operation.domain, operation.rulesetId, operation.ruleId);
        } else {
          await this.client.restorePanelRule(
            operation.domain,
            operation.rulesetId,
            operation.ruleId,
            operation.previous,
          );
        }
        results.push({ kind: operation.kind, domain: operation.domain, ok: true });
      } catch (error) {
        results.push({ kind: operation.kind, domain: operation.domain, ok: false, error: boundedText(error.message) });
      }
      context.update({ completed: results.length, results });
    }
    batch.rolledBackAt = new Date().toISOString();
    batch.rollbackStatus = results.some((item) => !item.ok) ? "partial" : "complete";
    this.saveHistory(batches);
    return {
      ok: results.every((item) => item.ok),
      total: results.length,
      completed: results.length,
      results,
      message: results.every((item) => item.ok)
        ? "Cloudflare automation rollback completed"
        : "Cloudflare automation rollback completed with failures",
    };
  }

  async fetchProxyRanges() {
    if (this.proxyRangesCache?.expiresAt > Date.now()) return this.proxyRangesCache.ranges;
    const response = await fetch("https://api.cloudflare.com/client/v4/ips", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Could not load trusted Cloudflare proxy ranges");
    const data = await response.json();
    if (!data.success) throw new Error("Cloudflare proxy range response was unsuccessful");
    const ranges = [...(data.result?.ipv4_cidrs || []), ...(data.result?.ipv6_cidrs || [])];
    this.proxyRangesCache = { ranges, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
    return ranges;
  }

  async validateIncidentAddress(address) {
    const value = String(address || "").trim();
    const family = net.isIP(value);
    if (!family || value.includes("/")) {
      throw Object.assign(new Error("Select one exact IPv4 or IPv6 address from current traffic"), { statusCode: 400 });
    }
    const type = family === 4 ? "ipv4" : "ipv6";
    if (reservedBlockList().check(value, type)) {
      throw Object.assign(new Error("Private, reserved, multicast, or documentation addresses cannot be mitigated"), {
        statusCode: 400,
      });
    }
    const protectedAddresses = [
      ...this.settings().protectedAddresses,
      ...addressList(this.serverAddresses()),
    ];
    if (protectedAddresses.includes(value)) {
      throw Object.assign(new Error("This address is protected by the operator or belongs to the hosting server"), {
        statusCode: 409,
      });
    }
    const proxies = new net.BlockList();
    for (const cidr of await this.proxyRangesProvider()) addSubnet(proxies, cidr);
    if (proxies.check(value, type)) {
      throw Object.assign(new Error("Cloudflare proxy addresses cannot be mitigated as visitors"), { statusCode: 409 });
    }
    return value;
  }

  incidentDefinition(domain, address, action, expiresAt) {
    const host = `(http.host eq "${domain}" or http.host eq "www.${domain}")`;
    const ref = `hosting-control-mitigation-${crypto.createHash("sha256")
      .update(`${domain}:${address}`).digest("hex").slice(0, 16)}`;
    return {
      phase: "http_request_firewall_custom",
      rule: {
        action,
        description: `[Hosting Control] Temporary mitigation for ${domain} until ${expiresAt}`,
        enabled: true,
        expression: `${host} and ip.src eq ${address}`,
        ref,
      },
    };
  }

  incidentHash(value) {
    return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  async previewIncident(input) {
    const site = (await this.sitesForDomains([input.domain]))[0];
    const action = String(input.action || "");
    if (!INCIDENT_ACTIONS.has(action)) {
      throw Object.assign(new Error("Unknown Cloudflare incident action"), { statusCode: 400 });
    }
    const duration = Number(input.duration);
    if (action !== "purge_cache" && !INCIDENT_DURATIONS.has(duration)) {
      throw Object.assign(new Error("Select a supported temporary mitigation duration"), { statusCode: 400 });
    }
    const address = action === "purge_cache" ? "" : await this.validateIncidentAddress(input.address);
    const expiresAt = action === "purge_cache" ? "" : new Date(Date.now() + duration * 1000).toISOString();
    const definition = action === "purge_cache" ? null : this.incidentDefinition(site.host, address, action, expiresAt);
    const zone = action === "purge_cache" ? await this.client.zoneForDomain(site.host) : null;
    const rule = definition ? await this.client.previewPanelRule(site.host, definition) : null;
    const preview = {
      domain: site.host,
      address,
      action,
      duration: action === "purge_cache" ? 0 : duration,
      expiresAt,
      zone: rule?.zone?.name || zone?.name || "",
      expression: definition?.rule?.expression || "",
      change: action === "purge_cache" ? "purge" : rule.change,
      sourceStatsAt: boundedText(input.sourceStatsAt, 80),
    };
    preview.id = this.incidentHash(preview);
    return preview;
  }

  incidentJob(preview, operator) {
    return this.jobManager.create({
      type: "cloudflare.incident-apply",
      label: preview.action === "purge_cache"
        ? `Purge Cloudflare cache for ${preview.domain}`
        : `Apply temporary Cloudflare mitigation for ${preview.domain}`,
      operator,
      trigger: "manual",
      payload: { preview, operator },
      targets: [preview.domain],
      conflicts: ["cloudflare-automation", `cloudflare:${preview.domain}`],
      total: 1,
      cancellable: false,
      retryable: true,
    });
  }

  removeIncidentJob(mitigationId, operator, trigger = "manual") {
    const incident = this.incidents().find((item) => item.id === mitigationId);
    if (!incident) throw Object.assign(new Error("Cloudflare mitigation was not found"), { statusCode: 404 });
    return this.jobManager.create({
      type: "cloudflare.incident-remove",
      label: `Remove temporary Cloudflare mitigation for ${incident.domain}`,
      operator,
      trigger,
      payload: { mitigationId },
      targets: [incident.domain],
      conflicts: ["cloudflare-automation", `cloudflare:${incident.domain}`],
      idempotencyKey: `cloudflare.incident-remove:${mitigationId}`,
      total: 1,
      cancellable: false,
      retryable: true,
    });
  }

  async applyIncident(payload, context) {
    const submitted = payload.preview || {};
    const { id: previewId, ...previewFields } = submitted;
    if (!previewId || previewId !== this.incidentHash(previewFields)) {
      throw Object.assign(new Error("Incident action requires an unchanged confirmed preview"), { statusCode: 409 });
    }
    if (submitted.action !== "purge_cache" && Date.parse(submitted.expiresAt) <= Date.now()) {
      throw Object.assign(new Error("Incident preview expired; create a new preview"), { statusCode: 409 });
    }
    if (submitted.action !== "purge_cache"
        && Date.parse(submitted.expiresAt) > Date.now() + Number(submitted.duration) * 1000 + 60_000) {
      throw Object.assign(new Error("Incident expiry exceeds the confirmed duration"), { statusCode: 409 });
    }
    const current = await this.previewIncident(submitted);
    context.update({ total: 1, currentStep: "Applying confirmed Cloudflare action" });
    if (submitted.action === "purge_cache") {
      await this.client.purgeZoneCache(submitted.domain);
      context.update({ completed: 1 });
      return { ok: true, total: 1, completed: 1, message: "Cloudflare zone cache purged" };
    }
    if (current.domain !== submitted.domain || current.address !== submitted.address
      || current.action !== submitted.action || current.duration !== submitted.duration) {
      throw Object.assign(new Error("Incident preview no longer matches the requested action"), { statusCode: 409 });
    }
    const applied = await this.client.applyPanelRule(
      submitted.domain,
      this.incidentDefinition(submitted.domain, submitted.address, submitted.action, submitted.expiresAt),
    );
    const incidents = this.incidents();
    const existing = incidents.find((item) =>
      !item.removedAt && item.domain === submitted.domain && item.address === submitted.address);
    const record = {
      id: existing?.id || crypto.randomUUID(),
      domain: submitted.domain,
      address: submitted.address,
      action: submitted.action,
      expression: submitted.expression,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: submitted.expiresAt,
      sourceStatsAt: submitted.sourceStatsAt,
      operator: boundedText(payload.operator, 160),
      rulesetId: applied.rulesetId,
      ruleId: applied.rule?.id,
      removedAt: "",
    };
    if (existing) Object.assign(existing, record);
    else incidents.unshift(record);
    this.saveIncidents(incidents);
    context.update({ completed: 1 });
    return {
      ok: true,
      total: 1,
      completed: 1,
      results: [{ ok: true, domain: record.domain, address: record.address, action: record.action, expiresAt: record.expiresAt }],
      message: "Temporary Cloudflare mitigation applied",
    };
  }

  async removeIncident(mitigationId, context) {
    const incidents = this.incidents();
    const incident = incidents.find((item) => item.id === mitigationId);
    if (!incident) throw Object.assign(new Error("Cloudflare mitigation was not found"), { statusCode: 404 });
    if (incident.removedAt) {
      return { ok: true, total: 1, completed: 1, message: "Cloudflare mitigation was already removed" };
    }
    context.update({ total: 1, currentStep: "Removing panel-owned Cloudflare mitigation" });
    try {
      await this.client.deleteSecurityRule(incident.domain, incident.rulesetId, incident.ruleId);
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
    incident.removedAt = new Date().toISOString();
    incident.removalTrigger = "job";
    this.saveIncidents(incidents);
    context.update({ completed: 1 });
    return { ok: true, total: 1, completed: 1, message: "Temporary Cloudflare mitigation removed" };
  }

  async expireIncidents() {
    for (const incident of this.incidents()) {
      if (!incident.removedAt && Date.parse(incident.expiresAt) <= Date.now()) {
        this.removeIncidentJob(incident.id, "scheduler", "scheduled");
      }
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.expireIncidents().catch((error) => {
      console.error(`Cloudflare mitigation expiry failed: ${error.message}`);
    }), 60_000);
    this.timer.unref();
    this.expireIncidents().catch((error) => console.error(`Cloudflare mitigation expiry failed: ${error.message}`));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  BULK_PRESETS,
  CloudflareAutomationManager,
  INCIDENT_ACTIONS,
  INCIDENT_DURATIONS,
  addressList,
  publicPresetView,
  reservedBlockList,
};
