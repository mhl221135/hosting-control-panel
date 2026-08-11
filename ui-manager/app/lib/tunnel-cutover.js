const fs = require("fs");
const path = require("path");
const { atomicWriteJson } = require("./safe-write");

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IDENTIFIER = /^[a-zA-Z0-9-]{16,64}$/;
const DNS_TYPES = new Set(["A", "AAAA", "CNAME"]);

function cutoverError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function normalizeHosts(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 250) {
    throw cutoverError("Select between 1 and 250 hostnames");
  }
  const hosts = [...new Set(values.map((value) => String(value || "").trim().toLowerCase()))];
  if (hosts.some((host) => !HOST.test(host))) throw cutoverError("Host list contains an invalid hostname");
  return hosts.sort();
}

function decodeTunnelToken(value) {
  const token = String(value || "").trim();
  if (!token || token.length > 4096) throw cutoverError("Cloudflare tunnel token is missing");
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw cutoverError("Cloudflare tunnel token is invalid");
  }
  const accountId = String(decoded.a || "");
  const tunnelId = String(decoded.t || "");
  if (!IDENTIFIER.test(accountId) || !IDENTIFIER.test(tunnelId)) {
    throw cutoverError("Cloudflare tunnel token does not contain valid account and tunnel identifiers");
  }
  return { accountId, tunnelId };
}

function recordPayload(record) {
  const payload = {
    type: String(record.type),
    name: String(record.name).toLowerCase(),
    content: String(record.content),
    ttl: Number(record.ttl || 1),
    proxied: Boolean(record.proxied),
  };
  if (record.priority !== undefined && record.priority !== null) payload.priority = Number(record.priority);
  if (record.comment) payload.comment = String(record.comment).slice(0, 500);
  if (Array.isArray(record.tags)) payload.tags = record.tags.slice(0, 20).map((value) => String(value).slice(0, 100));
  return payload;
}

function zoneForHost(zones, host) {
  return [...zones]
    .filter((zone) => host === zone.name || host.endsWith(`.${zone.name}`))
    .sort((left, right) => right.name.length - left.name.length)[0] || null;
}

function desiredTunnelConfig(current, hosts, service) {
  const config = current && typeof current === "object" ? structuredClone(current) : {};
  const ingress = Array.isArray(config.ingress) ? config.ingress : [];
  const selected = new Set(hosts);
  const existing = ingress.filter((rule) => !selected.has(String(rule.hostname || "").toLowerCase()));
  const catchAll = existing.filter((rule) => !rule.hostname);
  const named = existing.filter((rule) => rule.hostname);
  config.ingress = [
    ...named,
    ...hosts.map((hostname) => ({ hostname, service })),
    ...(catchAll.length ? catchAll : [{ service: "http_status:404" }]),
  ];
  if (config.ingress.length > 1000) throw cutoverError("Tunnel configuration would exceed 1000 ingress rules");
  return config;
}

class CloudflareCutoverApi {
  constructor({ token, fetchImpl = fetch, baseUrl = "https://api.cloudflare.com/client/v4" }) {
    this.token = String(token || "");
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl;
    if (!this.token) throw cutoverError("Cloudflare tunnel management token is missing");
  }

  async request(apiPath, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${apiPath}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!response.ok || data.success === false) {
      const detail = String(data.errors?.[0]?.message || data.message || `HTTP ${response.status}`).slice(0, 300);
      throw cutoverError(`Cloudflare request failed: ${detail}`, response.status || 502);
    }
    return data.result;
  }

  async zones() {
    const zones = [];
    for (let page = 1; page <= 20; page += 1) {
      const result = await this.request(`/zones?status=active&per_page=50&page=${page}`);
      zones.push(...(Array.isArray(result) ? result : []));
      if (!Array.isArray(result) || result.length < 50) break;
    }
    return zones.map((zone) => ({ id: String(zone.id), name: String(zone.name).toLowerCase() }));
  }

  tunnelConfig(accountId, tunnelId) {
    return this.request(`/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`);
  }

  updateTunnelConfig(accountId, tunnelId, config) {
    return this.request(`/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`, {
      method: "PUT",
      body: JSON.stringify({ config }),
    });
  }

  dnsRecords(zoneId, hostname) {
    return this.request(`/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`);
  }

  deleteDnsRecord(zoneId, recordId) {
    return this.request(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, { method: "DELETE" });
  }

  createDnsRecord(zoneId, payload) {
    return this.request(`/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }
}

class TunnelCutover {
  constructor(options) {
    this.api = options.api;
    this.accountId = String(options.accountId || "");
    this.tunnelId = String(options.tunnelId || "");
    this.service = String(options.service || "http://hosting-nginx:80");
    this.statePath = options.statePath;
    this.rolePath = options.rolePath;
    this.promotionPath = options.promotionPath;
    this.now = options.now || (() => new Date().toISOString());
    if (!IDENTIFIER.test(this.accountId) || !IDENTIFIER.test(this.tunnelId)) {
      throw cutoverError("Cloudflare account or tunnel identifier is invalid");
    }
  }

  readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  requirePromotedPrimary() {
    const role = this.readJson(this.rolePath);
    const promotion = this.readJson(this.promotionPath);
    if (role.role !== "primary" || promotion.status !== "local-primary") {
      throw cutoverError("Tunnel cutover requires a successfully promoted local primary", 409);
    }
    return { role, promotion };
  }

  async plan(values) {
    const hosts = normalizeHosts(values);
    const [zones, tunnel] = await Promise.all([
      this.api.zones(),
      this.api.tunnelConfig(this.accountId, this.tunnelId),
    ]);
    const config = tunnel?.config || tunnel || {};
    const desiredConfig = desiredTunnelConfig(config, hosts, this.service);
    const records = [];
    for (const hostname of hosts) {
      const zone = zoneForHost(zones, hostname);
      if (!zone) {
        records.push({ hostname, status: "blocked", reason: "No active Cloudflare zone" });
        continue;
      }
      const current = (await this.api.dnsRecords(zone.id, hostname)) || [];
      const ingress = current.filter((record) => DNS_TYPES.has(String(record.type)) && record.name === hostname);
      const unsupported = current.filter((record) => record.name === hostname && !DNS_TYPES.has(String(record.type)));
      records.push({
        hostname,
        zone,
        status: unsupported.length ? "blocked" : "ready",
        reason: unsupported.length ? "Conflicting non-ingress DNS record exists at hostname" : "",
        current: ingress.map((record) => ({ id: String(record.id), ...recordPayload(record) })),
        desired: {
          type: "CNAME",
          name: hostname,
          content: `${this.tunnelId}.cfargotunnel.com`,
          ttl: 1,
          proxied: true,
          comment: "Managed by Hosting Control standby cutover",
        },
      });
    }
    return {
      hosts,
      service: this.service,
      ready: records.every((record) => record.status === "ready"),
      tunnelChanged: JSON.stringify(config) !== JSON.stringify(desiredConfig),
      records,
      previousTunnelConfig: config,
      desiredTunnelConfig: desiredConfig,
    };
  }

  publicPlan(plan) {
    return {
      hosts: plan.hosts,
      service: plan.service,
      ready: plan.ready,
      tunnelChanged: plan.tunnelChanged,
      records: plan.records.map(({ current, desired, ...record }) => ({
        ...record,
        current: (current || []).map(({ id, ...item }) => item),
        desired,
      })),
    };
  }

  async replaceDns(entry, desired) {
    for (const record of entry.current || []) await this.api.deleteDnsRecord(entry.zone.id, record.id);
    await this.api.createDnsRecord(entry.zone.id, desired);
  }

  async restoreDns(entry) {
    const current = (await this.api.dnsRecords(entry.zone.id, entry.hostname)) || [];
    for (const record of current.filter((item) => DNS_TYPES.has(String(item.type)) && item.name === entry.hostname)) {
      await this.api.deleteDnsRecord(entry.zone.id, record.id);
    }
    for (const record of entry.current || []) await this.api.createDnsRecord(entry.zone.id, recordPayload(record));
  }

  async apply(values, confirmation) {
    if (confirmation !== "SWITCH-TUNNEL-INGRESS") throw cutoverError("Apply requires SWITCH-TUNNEL-INGRESS confirmation");
    const { promotion } = this.requirePromotedPrimary();
    if (fs.existsSync(this.statePath)) throw cutoverError("A tunnel cutover state already exists; rollback or archive it first", 409);
    const plan = await this.plan(values);
    if (!plan.ready) throw cutoverError("Tunnel cutover preview contains blocked hostnames", 409);
    const state = {
      version: 1,
      status: "applying",
      startedAt: this.now(),
      accountId: this.accountId,
      tunnelId: this.tunnelId,
      hosts: plan.hosts,
      previousTunnelConfig: plan.previousTunnelConfig,
      dns: plan.records.map((entry) => ({ hostname: entry.hostname, zone: entry.zone, current: entry.current })),
    };
    atomicWriteJson(this.statePath, state, 0o600);
    try {
      await this.api.updateTunnelConfig(this.accountId, this.tunnelId, plan.desiredTunnelConfig);
      for (const entry of plan.records) await this.replaceDns(entry, entry.desired);
      state.status = "active";
      state.completedAt = this.now();
      atomicWriteJson(this.statePath, state, 0o600);
      atomicWriteJson(this.promotionPath, { ...promotion, public_ingress_cutover: true }, 0o644);
      return { ok: true, status: "active", hosts: plan.hosts };
    } catch (error) {
      let rollbackError = null;
      try {
        await this.api.updateTunnelConfig(this.accountId, this.tunnelId, state.previousTunnelConfig);
        for (const entry of state.dns) await this.restoreDns(entry);
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
      }
      state.status = rollbackError ? "rollback-failed" : "rolled-back";
      state.error = String(error.message).slice(0, 300);
      if (rollbackError) state.rollbackError = String(rollbackError.message).slice(0, 300);
      atomicWriteJson(this.statePath, state, 0o600);
      throw error;
    }
  }

  async rollback(confirmation) {
    if (confirmation !== "ROLLBACK-TUNNEL-INGRESS") throw cutoverError("Rollback requires ROLLBACK-TUNNEL-INGRESS confirmation");
    const { promotion } = this.requirePromotedPrimary();
    const state = this.readJson(this.statePath);
    if (state.version !== 1 || !["active", "rollback-failed"].includes(state.status)) {
      throw cutoverError("No active tunnel cutover can be rolled back", 409);
    }
    await this.api.updateTunnelConfig(this.accountId, this.tunnelId, state.previousTunnelConfig);
    for (const entry of state.dns || []) await this.restoreDns(entry);
    state.status = "rolled-back";
    state.rolledBackAt = this.now();
    atomicWriteJson(this.statePath, state, 0o600);
    atomicWriteJson(this.promotionPath, { ...promotion, public_ingress_cutover: false }, 0o644);
    return { ok: true, status: "rolled-back", hosts: state.hosts || [] };
  }
}

module.exports = {
  CloudflareCutoverApi,
  TunnelCutover,
  decodeTunnelToken,
  desiredTunnelConfig,
  normalizeHosts,
  recordPayload,
  zoneForHost,
};
