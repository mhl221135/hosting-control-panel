const fs = require("fs");
const net = require("net");
const path = require("path");

const CLOUDFLARE_V4 = [
  ["173.245.48.0", 20], ["103.21.244.0", 22], ["103.22.200.0", 22], ["103.31.4.0", 22],
  ["141.101.64.0", 18], ["108.162.192.0", 18], ["190.93.240.0", 20], ["188.114.96.0", 20],
  ["197.234.240.0", 22], ["198.41.128.0", 17], ["162.158.0.0", 15], ["104.16.0.0", 13],
  ["104.24.0.0", 14], ["172.64.0.0", 13], ["131.0.72.0", 22],
];
const CLOUDFLARE_V6 = [
  ["2400:cb00::", 32], ["2606:4700::", 32], ["2803:f800::", 32], ["2405:b500::", 32],
  ["2405:8100::", 32], ["2a06:98c0::", 29], ["2c0f:f248::", 32],
];

function blockList() {
  const list = new net.BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4], ...CLOUDFLARE_V4,
  ]) list.addSubnet(address, prefix, "ipv4");
  for (const [address, prefix] of [
    ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
    ["2001:db8::", 32], ...CLOUDFLARE_V6,
  ]) list.addSubnet(address, prefix, "ipv6");
  return list;
}

const BLOCKED = blockList();

function validateLookupIp(value, protectedAddresses = []) {
  const ip = String(value || "").trim();
  const family = net.isIP(ip);
  if (!family) throw Object.assign(new Error("Enter a valid IP address"), { statusCode: 400 });
  if ((family === 6 && /^::ffff:/i.test(ip))
      || BLOCKED.check(ip, family === 4 ? "ipv4" : "ipv6") || protectedAddresses.includes(ip)) {
    throw Object.assign(new Error("Private, reserved, proxy-edge, and configured server addresses cannot be enriched"), { statusCode: 400 });
  }
  return ip;
}

function text(value, maximum = 160) {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum) : "";
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function normalizeResponse(data, ip) {
  const geo = data.geo || data;
  const as = data.as || data.asn || {};
  const legacyOrg = text(data.org);
  const asnMatch = legacyOrg.match(/^(AS\d+)\s+(.+)$/i);
  const privacy = data.privacy || {};
  return {
    ip,
    hostname: text(data.hostname),
    city: text(geo.city),
    region: text(geo.region),
    country: text(geo.country || geo.country_code, 80),
    asn: text(as.asn || as.asn_id || asnMatch?.[1], 32),
    organization: text(as.name || as.organization || data.company?.name || asnMatch?.[2] || legacyOrg),
    network: text(as.network || data.network || data.company?.network, 80),
    indicators: {
      hosting: booleanOrNull(data.is_hosting ?? privacy.hosting),
      anonymous: booleanOrNull(data.is_anonymous ?? privacy.anonymous),
      proxy: booleanOrNull(data.is_proxy ?? privacy.proxy),
      vpn: booleanOrNull(data.is_vpn ?? privacy.vpn),
      tor: booleanOrNull(data.is_tor ?? privacy.tor),
      relay: booleanOrNull(data.is_relay ?? privacy.relay),
    },
  };
}

class IpinfoClient {
  constructor(options = {}) {
    this.settings = options.settings;
    this.dataDir = options.dataDir;
    this.fetch = options.fetch || global.fetch;
    this.now = options.now || (() => Date.now());
    this.ttlMs = Number(options.ttlMs || 24 * 60 * 60 * 1000);
    this.maxEntries = Number(options.maxEntries || 500);
    this.path = path.join(this.dataDir, "ipinfo-cache.json");
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.path, "utf8"));
      const entries = value && typeof value.entries === "object" ? value.entries : {};
      const current = Object.fromEntries(Object.entries(entries).filter(([, entry]) =>
        entry?.lookedUpAt && this.now() - new Date(entry.lookedUpAt).getTime() < this.ttlMs));
      if (Object.keys(current).length !== Object.keys(entries).length) this.write(current);
      return current;
    } catch {
      return {};
    }
  }

  write(entries) {
    const sorted = Object.entries(entries)
      .sort((left, right) => String(right[1].lookedUpAt).localeCompare(String(left[1].lookedUpAt)))
      .slice(0, this.maxEntries);
    const temporary = `${this.path}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries: Object.fromEntries(sorted) }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, this.path);
  }

  configured() {
    return Boolean(this.settings().ipinfoToken);
  }

  async lookup(value, protectedAddresses = [], options = {}) {
    const ip = validateLookupIp(value, protectedAddresses);
    const entries = this.read();
    const cached = entries[ip];
    if (!options.force && cached) {
      return { ...cached, cached: true };
    }
    const token = this.settings().ipinfoToken;
    if (!token) throw Object.assign(new Error("Configure an IPinfo token in Settings first"), { statusCode: 409 });
    const response = await this.fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      let message = `IPinfo request failed (${response.status})`;
      try {
        const body = await response.json();
        if (body?.error?.title) message += `: ${text(body.error.title, 120)}`;
      } catch {}
      throw Object.assign(new Error(message), { statusCode: 502 });
    }
    const normalized = normalizeResponse(await response.json(), ip);
    const result = { ...normalized, lookedUpAt: new Date(this.now()).toISOString() };
    entries[ip] = result;
    this.write(entries);
    return { ...result, cached: false };
  }

  clear() {
    fs.rmSync(this.path, { force: true });
  }
}

module.exports = { IpinfoClient, normalizeResponse, validateLookupIp };
