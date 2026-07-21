const crypto = require("crypto");
const dns = require("dns").promises;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function resolvePublicAddress(domain) {
  try {
    const addresses = await dns.resolve4(domain);
    if (addresses.length) return addresses;
  } catch (error) {
    if (!["ENODATA", "ENOTFOUND", "SERVFAIL"].includes(error.code)) throw error;
  }
  return dns.resolve6(domain);
}

class IntegrationError extends Error {
  constructor(message, statusCode = 502, details = "") {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

async function readResponse(response) {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.errors?.[0]?.message || data?.message || `HTTP ${response.status}`;
    throw new IntegrationError(message, response.status, text.slice(0, 2000));
  }
  return data;
}

class NpmClient {
  constructor(settingsProvider = null, options = {}) {
    this.settingsProvider = settingsProvider;
    this.cachedToken = null;
    this.resolveDns = options.resolveDns || resolvePublicAddress;
    this.sleep = options.sleep || sleep;
    this.dnsAttempts = Number(options.dnsAttempts || 24);
    this.dnsDelayMs = Number(options.dnsDelayMs || 5000);
  }

  settings() {
    if (this.settingsProvider) {
      const settings = this.settingsProvider();
      return {
        baseUrl: String(settings.npmApiUrl || "http://hosting-npm:81/api").replace(/\/$/, ""),
        identity: String(settings.npmIdentity || ""),
        secret: String(settings.npmSecret || ""),
        acmeEmail: String(settings.acmeEmail || ""),
      };
    }
    return {
      baseUrl: String(process.env.NPM_API_URL || "http://hosting-npm:81/api").replace(/\/$/, ""),
      identity: String(process.env.NPM_IDENTITY || ""),
      secret: String(process.env.NPM_SECRET || ""),
      acmeEmail: String(process.env.ACME_EMAIL || ""),
    };
  }

  configured() {
    const settings = this.settings();
    return Boolean(settings.identity && settings.secret);
  }

  async token() {
    if (!this.configured()) throw new IntegrationError("NPM credentials are not configured", 503);
    const settings = this.settings();
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) return this.cachedToken.value;
    const response = await fetch(`${settings.baseUrl}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: settings.identity, secret: settings.secret }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await readResponse(response);
    if (!data.token) throw new IntegrationError("NPM did not return an access token");
    this.cachedToken = {
      value: data.token,
      expiresAt: data.expires ? new Date(data.expires).getTime() : Date.now() + 50 * 60_000,
    };
    return data.token;
  }

  async request(path, options = {}) {
    const settings = this.settings();
    const token = await this.token();
    const response = await fetch(`${settings.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(options.timeout || 120_000),
    });
    return readResponse(response);
  }

  async listHosts() {
    return this.request("/nginx/proxy-hosts?expand=certificate,access_list");
  }

  async listCertificates() {
    return this.request("/nginx/certificates?expand=owner");
  }

  async deleteHost(hostId) {
    return this.request(`/nginx/proxy-hosts/${Number(hostId)}`, { method: "DELETE" });
  }

  async deleteCertificate(certificateId) {
    return this.request(`/nginx/certificates/${Number(certificateId)}`, { method: "DELETE" });
  }

  async findHost(domain) {
    const hosts = await this.listHosts();
    return hosts.find((host) => Array.isArray(host.domain_names) && host.domain_names.includes(domain)) || null;
  }

  async createHost(domains) {
    const existing = await this.findHost(domains[0]);
    if (existing) return existing;
    return this.request("/nginx/proxy-hosts", {
      method: "POST",
      body: JSON.stringify({
        domain_names: domains,
        forward_scheme: "http",
        forward_host: "hosting-nginx",
        forward_port: 80,
        certificate_id: 0,
        ssl_forced: false,
        hsts_enabled: false,
        hsts_subdomains: false,
        http2_support: false,
        block_exploits: true,
        caching_enabled: false,
        allow_websocket_upgrade: true,
        access_list_id: 0,
        advanced_config: "",
        enabled: true,
        locations: [],
      }),
    });
  }

  hostPayload(host, overrides = {}) {
    return {
      domain_names: host.domain_names || [],
      forward_scheme: host.forward_scheme || "http",
      forward_host: host.forward_host || "hosting-nginx",
      forward_port: Number(host.forward_port || 80),
      certificate_id: Number(host.certificate_id || 0),
      ssl_forced: Boolean(host.ssl_forced),
      http2_support: Boolean(host.http2_support),
      hsts_enabled: Boolean(host.hsts_enabled),
      hsts_subdomains: Boolean(host.hsts_subdomains),
      block_exploits: host.block_exploits !== false,
      caching_enabled: Boolean(host.caching_enabled),
      allow_websocket_upgrade: host.allow_websocket_upgrade !== false,
      access_list_id: Number(host.access_list_id || 0),
      advanced_config: host.advanced_config || "",
      enabled: host.enabled !== false,
      locations: Array.isArray(host.locations) ? host.locations : [],
      meta: host.meta || {},
      ...overrides,
    };
  }

  async updateHost(host, overrides = {}) {
    return this.request(`/nginx/proxy-hosts/${host.id}`, {
      method: "PUT",
      body: JSON.stringify(this.hostPayload(host, overrides)),
    });
  }

  async waitForDns(domains) {
    let pending = [...new Set(domains)];
    for (let attempt = 1; attempt <= this.dnsAttempts; attempt += 1) {
      const results = await Promise.all(pending.map(async (domain) => {
        try {
          const addresses = await this.resolveDns(domain);
          return Array.isArray(addresses) && addresses.length > 0 ? null : domain;
        } catch {
          return domain;
        }
      }));
      pending = results.filter(Boolean);
      if (pending.length === 0) return;
      if (attempt < this.dnsAttempts) await this.sleep(this.dnsDelayMs);
    }
    throw new IntegrationError(
      `DNS is not ready for: ${pending.join(", ")}. Wait for propagation, then retry SSL.`,
      409,
    );
  }

  async issueCertificate(host) {
    const domains = host.domain_names || [];
    const settings = this.settings();
    if (!settings.acmeEmail) throw new IntegrationError("ACME email is not configured", 400);
    await this.waitForDns(domains);
    const certificate = await this.request("/nginx/certificates", {
      method: "POST",
      body: JSON.stringify({
        provider: "letsencrypt",
        nice_name: domains[0],
        domain_names: domains,
        meta: {
          dns_challenge: false,
          key_type: "ecdsa",
        },
      }),
      timeout: 180_000,
    });
    return this.updateHost(host, {
      certificate_id: certificate.id,
      ssl_forced: true,
      http2_support: true,
      hsts_enabled: true,
      hsts_subdomains: false,
    });
  }

  async ensureHost(domains, issueSsl) {
    let host = await this.createHost(domains);
    const currentDomains = Array.isArray(host.domain_names) ? host.domain_names : [];
    const mergedDomains = [...new Set([...currentDomains, ...domains])];
    const domainsChanged = domains.some((domain) => !currentDomains.includes(domain));
    if (host.forward_host !== "hosting-nginx" || Number(host.forward_port) !== 80 || domainsChanged) {
      host = await this.updateHost(host, {
        domain_names: mergedDomains,
        forward_scheme: "http",
        forward_host: "hosting-nginx",
        forward_port: 80,
      });
    }
    if (!issueSsl || (host.certificate_id && !domainsChanged)) return host;
    return this.issueCertificate(host);
  }

  async renewCertificate(certificateId) {
    return this.request(`/nginx/certificates/${Number(certificateId)}/renew`, { method: "POST" });
  }
}

class CloudflareClient {
  constructor(settingsProvider = null, options = {}) {
    this.settingsProvider = settingsProvider;
    this.baseUrl = "https://api.cloudflare.com/client/v4";
    this.tokenSetting = options.tokenSetting || "cloudflareToken";
    this.tokenEnvironment = options.tokenEnvironment || "CLOUDFLARE_API_TOKEN";
    this.integrationName = options.integrationName || "Cloudflare";
  }

  token() {
    if (this.settingsProvider) return String(this.settingsProvider()[this.tokenSetting] || "");
    return String(process.env[this.tokenEnvironment] || "");
  }

  accountId() {
    if (this.settingsProvider) return String(this.settingsProvider().cloudflareAccountId || "");
    return String(process.env.CLOUDFLARE_ACCOUNT_ID || "");
  }

  configured() {
    return Boolean(this.token());
  }

  async request(path, options = {}) {
    if (!this.configured()) throw new IntegrationError(`${this.integrationName} API token is not configured`, 503);
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token()}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const data = await readResponse(response);
    if (data.success === false) {
      throw new IntegrationError(data.errors?.[0]?.message || "Cloudflare request failed");
    }
    return data;
  }

  async zoneForDomain(domain) {
    const labels = String(domain).toLowerCase().split(".");
    for (let index = 0; index <= labels.length - 2; index += 1) {
      const name = labels.slice(index).join(".");
      const data = await this.request(`/zones?name=${encodeURIComponent(name)}&status=active`);
      if (Array.isArray(data.result) && data.result.length) return data.result[0];
    }
    throw new IntegrationError(`No active Cloudflare zone found for ${domain}`, 404);
  }

  async verify() {
    const token = this.token();
    const accountId = this.accountId();
    if (token.startsWith("cfat_") && !accountId) {
      throw new IntegrationError("Cloudflare Account ID is required for an account-owned token", 400);
    }
    const endpoint = token.startsWith("cfat_")
      ? `/accounts/${encodeURIComponent(accountId)}/tokens/verify`
      : "/user/tokens/verify";
    const data = await this.request(endpoint);
    return data.result || {};
  }

  async zones() {
    const zones = [];
    let page = 1;
    while (true) {
      const data = await this.request(`/zones?status=active&per_page=50&page=${page}`);
      zones.push(...(data.result || []));
      if (page >= Number(data.result_info?.total_pages || 1)) break;
      page += 1;
    }
    return zones;
  }

  async records(domain) {
    const zone = await this.zoneForDomain(domain);
    const data = await this.request(`/zones/${zone.id}/dns_records?per_page=5000`);
    const records = (data.result || []).filter((record) =>
      record.name === domain || record.name.endsWith(`.${domain}`));
    return {
      zone: { id: zone.id, name: zone.name },
      scope: domain,
      records: records.sort((left, right) =>
        left.name.localeCompare(right.name) || left.type.localeCompare(right.type)),
    };
  }

  recordPayload(domain, record) {
    const type = String(record.type || "A").toUpperCase();
    const name = String(record.name || domain).trim().toLowerCase();
    const content = String(record.content || "").trim();
    if (!["A", "AAAA", "CNAME", "TXT", "MX", "CAA"].includes(type)) {
      throw new IntegrationError("Supported DNS types are A, AAAA, CNAME, TXT, MX and CAA", 400);
    }
    if (!content) throw new IntegrationError("DNS record content is required", 400);
    const ttl = Number(record.ttl || 1);
    if (ttl !== 1 && (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400)) {
      throw new IntegrationError("TTL must be automatic (1) or between 60 and 86400 seconds", 400);
    }
    const payload = {
      type,
      name,
      content,
      ttl,
      proxied: ["A", "AAAA", "CNAME"].includes(type) ? Boolean(record.proxied) : false,
      comment: String(record.comment || "Managed by Websites Config UI"),
    };
    if (type === "MX") {
      const priority = Number(record.priority || 10);
      if (!Number.isInteger(priority) || priority < 0 || priority > 65535) {
        throw new IntegrationError("MX priority must be between 0 and 65535", 400);
      }
      payload.priority = priority;
    }
    return payload;
  }

  async createRecord(domain, record) {
    const zone = await this.zoneForDomain(domain);
    return this.request(`/zones/${zone.id}/dns_records`, {
      method: "POST",
      body: JSON.stringify(this.recordPayload(domain, record)),
    });
  }

  async updateRecord(domain, recordId, record) {
    const zone = await this.zoneForDomain(domain);
    return this.request(`/zones/${zone.id}/dns_records/${encodeURIComponent(recordId)}`, {
      method: "PUT",
      body: JSON.stringify(this.recordPayload(domain, record)),
    });
  }

  async upsertRecord(domain, record) {
    const zone = await this.zoneForDomain(domain);
    const payload = this.recordPayload(domain, record);
    const existingData = await this.request(
      `/zones/${zone.id}/dns_records?type=${encodeURIComponent(payload.type)}&name=${encodeURIComponent(payload.name)}`,
    );
    const existing = existingData.result?.[0];
    if (existing) {
      return this.request(`/zones/${zone.id}/dns_records/${existing.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    }
    return this.request(`/zones/${zone.id}/dns_records`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async upsertHostAddress(domain, ipv4, proxied = true) {
    const zone = await this.zoneForDomain(domain);
    const name = String(domain || "").trim().toLowerCase();
    const data = await this.request(
      `/zones/${zone.id}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
    );
    const records = data.result || [];
    const existingA = records.find((record) => record.type === "A");
    for (const record of records.filter((item) => ["AAAA", "CNAME"].includes(item.type))) {
      await this.request(`/zones/${zone.id}/dns_records/${record.id}`, { method: "DELETE" });
    }
    const payload = this.recordPayload(domain, {
      type: "A",
      name,
      content: ipv4,
      ttl: 1,
      proxied,
      comment: "Managed by Websites migration import",
    });
    if (existingA) {
      return this.request(`/zones/${zone.id}/dns_records/${existingA.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    }
    return this.request(`/zones/${zone.id}/dns_records`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async deleteRecord(domain, recordId) {
    const zone = await this.zoneForDomain(domain);
    return this.request(`/zones/${zone.id}/dns_records/${encodeURIComponent(recordId)}`, {
      method: "DELETE",
    });
  }

  async replaceARecords(fromIp, toIp) {
    const zones = await this.zones();
    const changes = [];
    for (const zone of zones) {
      const data = await this.request(
        `/zones/${zone.id}/dns_records?type=A&content=${encodeURIComponent(fromIp)}&per_page=5000`,
      );
      for (const record of data.result || []) {
        const payload = {
          type: "A",
          name: record.name,
          content: toIp,
          ttl: Number(record.ttl || 1),
          proxied: Boolean(record.proxied),
          comment: record.comment || "Managed by Websites Config UI",
          tags: Array.isArray(record.tags) ? record.tags : [],
        };
        await this.request(`/zones/${zone.id}/dns_records/${record.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        changes.push({ zone: zone.name, name: record.name, from: fromIp, to: toIp });
      }
    }
    return { zonesChecked: zones.length, changed: changes.length, records: changes };
  }

  securityRuleReference(domain, preset) {
    const hostId = crypto.createHash("sha256").update(String(domain)).digest("hex").slice(0, 12);
    return `hosting-control-${preset}-${hostId}`;
  }

  securityPreset(domain, preset) {
    const host = `(http.host eq "${domain}" or http.host eq "www.${domain}")`;
    const common = {
      enabled: true,
      ref: this.securityRuleReference(domain, preset),
    };
    if (preset === "suspicious-probes") {
      return {
        phase: "http_request_firewall_custom",
        rule: {
          ...common,
          action: "block",
          description: `[Hosting Control] Block sensitive-file probes for ${domain}`,
          expression: `${host} and http.request.uri.path in {"/.env" "/.git/config" "/wp-config.php" "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php" "/_ignition/execute-solution"}`,
        },
      };
    }
    if (preset === "xmlrpc-challenge") {
      return {
        phase: "http_request_firewall_custom",
        rule: {
          ...common,
          action: "managed_challenge",
          description: `[Hosting Control] Challenge XML-RPC requests for ${domain}`,
          expression: `${host} and http.request.uri.path eq "/xmlrpc.php"`,
        },
      };
    }
    if (preset === "login-rate-limit") {
      return {
        phase: "http_ratelimit",
        rule: {
          ...common,
          action: "block",
          description: `[Hosting Control] Rate limit WordPress login zone for ${domain}`,
          expression: `http.request.uri.path eq "/wp-login.php"`,
          ratelimit: {
            characteristics: ["cf.colo.id", "ip.src"],
            period: 10,
            requests_per_period: 5,
            mitigation_timeout: 10,
          },
        },
      };
    }
    throw new IntegrationError("Unknown Cloudflare security preset", 400);
  }

  async phaseRuleset(zoneId, phase, allowMissing = false) {
    try {
      const data = await this.request(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`);
      return data.result || null;
    } catch (error) {
      if (allowMissing && error.statusCode === 404) return null;
      throw error;
    }
  }

  async securityRules(domain) {
    const zone = await this.zoneForDomain(domain);
    const phases = ["http_request_firewall_custom", "http_ratelimit"];
    const rules = [];
    for (const phase of phases) {
      const ruleset = await this.phaseRuleset(zone.id, phase, true);
      for (const rule of ruleset?.rules || []) {
        if (!String(rule.ref || "").startsWith("hosting-control-")) continue;
        if (!String(rule.description || "").includes(domain)) continue;
        rules.push({
          id: rule.id,
          rulesetId: ruleset.id,
          phase,
          ref: rule.ref,
          description: rule.description,
          action: rule.action,
          enabled: rule.enabled !== false,
          ratelimit: rule.ratelimit || null,
        });
      }
    }
    return { zone: { id: zone.id, name: zone.name }, domain, rules };
  }

  async applySecurityPreset(domain, preset) {
    const zone = await this.zoneForDomain(domain);
    const definition = this.securityPreset(domain, preset);
    let ruleset = await this.phaseRuleset(zone.id, definition.phase, true);
    const existing = (ruleset?.rules || []).find((rule) => rule.ref === definition.rule.ref);
    if (existing) return { created: false, rule: existing, zone: { id: zone.id, name: zone.name } };
    if (!ruleset) {
      const result = await this.request(`/zones/${zone.id}/rulesets`, {
        method: "POST",
        body: JSON.stringify({
          name: `Hosting Control ${definition.phase}`,
          description: "Rules managed by Hosting Control",
          kind: "zone",
          phase: definition.phase,
          rules: [definition.rule],
        }),
      });
      return { created: true, rule: result.result?.rules?.[0], zone: { id: zone.id, name: zone.name } };
    }
    const result = await this.request(`/zones/${zone.id}/rulesets/${ruleset.id}/rules`, {
      method: "POST",
      body: JSON.stringify(definition.rule),
    });
    return { created: true, rule: result.result, zone: { id: zone.id, name: zone.name } };
  }

  async updateSecurityRule(domain, rulesetId, ruleId, enabled) {
    const zone = await this.zoneForDomain(domain);
    const rules = await this.securityRules(domain);
    const rule = rules.rules.find((item) => item.rulesetId === rulesetId && item.id === ruleId);
    if (!rule) throw new IntegrationError("Panel-managed Cloudflare rule was not found", 404);
    const result = await this.request(`/zones/${zone.id}/rulesets/${rulesetId}/rules/${ruleId}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: Boolean(enabled) }),
    });
    return result.result;
  }

  async deleteSecurityRule(domain, rulesetId, ruleId) {
    const zone = await this.zoneForDomain(domain);
    const rules = await this.securityRules(domain);
    const rule = rules.rules.find((item) => item.rulesetId === rulesetId && item.id === ruleId);
    if (!rule) throw new IntegrationError("Panel-managed Cloudflare rule was not found", 404);
    await this.request(`/zones/${zone.id}/rulesets/${rulesetId}/rules/${ruleId}`, { method: "DELETE" });
  }
}

module.exports = { CloudflareClient, IntegrationError, NpmClient };
