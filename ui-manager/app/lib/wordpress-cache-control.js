const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { atomicWriteFile, atomicWriteJson } = require("./safe-write");

const VERSION = "1.1.0";
const PLUGIN_FILE = "hosting-cache-control.php";
const CONFIG_FILE = "hosting-cache-control-config.php";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function cacheControlError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length === 64 && crypto.timingSafeEqual(a, b);
}

function phpString(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

class WordPressCacheControl {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    this.websitesRoot = options.websitesRoot;
    this.pluginSource = options.pluginSource || path.resolve(__dirname, "../wordpress/hosting-cache-control.php");
    this.endpoint = options.endpoint || "http://hosting-ui:8687/remote/cache/v1/purge";
    this.statePath = options.statePath || path.join(this.dataDir, "wordpress-cache-control.json");
    this.maxAudit = Math.max(20, Math.min(Number(options.maxAudit) || 250, 1000));
    this.rateLimit = Math.max(2, Math.min(Number(options.rateLimit) || 20, 120));
    this.now = options.now || (() => Date.now());
    this.requests = new Map();
  }

  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      return value?.version === 1 && value.sites && typeof value.sites === "object"
        ? { version: 1, sites: value.sites, audit: Array.isArray(value.audit) ? value.audit : [] }
        : { version: 1, sites: {}, audit: [] };
    } catch {
      return { version: 1, sites: {}, audit: [] };
    }
  }

  write(state) {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o750 });
    atomicWriteJson(this.statePath, {
      version: 1,
      sites: state.sites,
      audit: state.audit.slice(0, this.maxAudit),
    }, 0o600);
  }

  record(domain, operation, result, layers = []) {
    const state = this.read();
    state.audit.unshift({
      at: new Date(this.now()).toISOString(),
      domain: String(domain).slice(0, 253),
      operation: ["install", "rotate", "purge", "remove"].includes(operation) ? operation : "purge",
      result: result === "success" ? "success" : "failed",
      layers: [...new Set(layers)].filter((item) => ["fastcgi", "cloudflare", "opcache", "redis"].includes(item)).slice(0, 4),
    });
    this.write(state);
  }

  sitePath(directory) {
    const relative = String(directory || "").replace(/^\/+/, "");
    if (!relative || relative.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(relative)) {
      throw cacheControlError("WordPress directory is invalid");
    }
    const root = path.resolve(this.websitesRoot);
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw cacheControlError("WordPress directory is outside the website root");
    return resolved;
  }

  config(domain, token) {
    return `<?php\n// Managed by Hosting Control. Site-scoped credential; do not copy between websites.\nif (!defined('HOSTING_CACHE_CONTROL_DOMAIN')) define('HOSTING_CACHE_CONTROL_DOMAIN', ${phpString(domain)});\nif (!defined('HOSTING_CACHE_CONTROL_TOKEN')) define('HOSTING_CACHE_CONTROL_TOKEN', ${phpString(token)});\nif (!defined('HOSTING_CACHE_CONTROL_ENDPOINT')) define('HOSTING_CACHE_CONTROL_ENDPOINT', ${phpString(this.endpoint)});\n`;
  }

  install(site, options = {}) {
    const domain = String(site.host || "").toLowerCase();
    const directory = String(site.directory || "");
    const siteRoot = this.sitePath(directory);
    if (!fs.existsSync(path.join(siteRoot, "wp-config.php"))) throw cacheControlError(`${domain} is not a WordPress installation`, 409);
    const source = fs.readFileSync(this.pluginSource, "utf8");
    const muRoot = path.join(siteRoot, "wp-content", "mu-plugins");
    fs.mkdirSync(muRoot, { recursive: true, mode: 0o775 });
    const state = this.read();
    const current = state.sites[domain];
    const rotate = Boolean(options.rotate) || !current?.tokenHash;
    const token = rotate ? crypto.randomBytes(32).toString("base64url") : null;
    if (rotate) atomicWriteFile(path.join(muRoot, CONFIG_FILE), this.config(domain, token), 0o640);
    else if (!fs.existsSync(path.join(muRoot, CONFIG_FILE))) {
      throw cacheControlError(`${domain} credential file is missing; rotate its credential to repair it`, 409);
    }
    atomicWriteFile(path.join(muRoot, PLUGIN_FILE), source, 0o644);
    const at = new Date(this.now()).toISOString();
    state.sites[domain] = {
      tokenHash: rotate ? tokenHash(token) : current.tokenHash,
      directory,
      version: VERSION,
      installedAt: current?.installedAt || at,
      updatedAt: at,
      rotatedAt: rotate ? at : (current?.rotatedAt || ""),
    };
    state.audit.unshift({ at, domain, operation: rotate && current ? "rotate" : "install", result: "success", layers: [] });
    this.write(state);
    return { domain, version: VERSION, rotated: rotate };
  }

  installMany(sites, options = {}) {
    const results = [];
    for (const site of sites) {
      try {
        results.push({ ok: true, ...this.install(site, options) });
      } catch (error) {
        results.push({ ok: false, domain: site.host, message: String(error.message).slice(0, 240) });
      }
    }
    return {
      ok: results.every((item) => item.ok),
      completed: results.filter((item) => item.ok).length,
      total: results.length,
      results,
    };
  }

  remove(site) {
    const domain = String(site.host || "").toLowerCase();
    const muRoot = path.join(this.sitePath(site.directory), "wp-content", "mu-plugins");
    fs.rmSync(path.join(muRoot, PLUGIN_FILE), { force: true });
    fs.rmSync(path.join(muRoot, CONFIG_FILE), { force: true });
    const state = this.read();
    delete state.sites[domain];
    state.audit.unshift({ at: new Date(this.now()).toISOString(), domain, operation: "remove", result: "success", layers: [] });
    this.write(state);
    return { domain, removed: true };
  }

  status(sites) {
    const state = this.read();
    return sites.map((site) => {
      const saved = state.sites[site.host];
      const muRoot = path.join(this.sitePath(site.directory), "wp-content", "mu-plugins");
      return {
        domain: site.host,
        installed: Boolean(saved && fs.existsSync(path.join(muRoot, PLUGIN_FILE)) && fs.existsSync(path.join(muRoot, CONFIG_FILE))),
        version: saved?.version || "",
        updatedAt: saved?.updatedAt || "",
      };
    });
  }

  authenticate(domain, token, address = "") {
    const saved = this.read().sites[String(domain || "").toLowerCase()];
    const valid = Boolean(TOKEN_PATTERN.test(String(token || "")) && saved && safeEqual(saved.tokenHash, tokenHash(token)));
    const key = `${domain}:${address}:${valid ? "success" : "failure"}`;
    const cutoff = this.now() - 60_000;
    const recent = (this.requests.get(key) || []).filter((time) => time > cutoff);
    if (recent.length >= this.rateLimit) throw cacheControlError("Cache-control rate limit exceeded", 429);
    recent.push(this.now());
    this.requests.set(key, recent);
    if (!valid) {
      this.record(domain, "purge", "failed", []);
      throw cacheControlError("Cache-control authentication failed", 401);
    }
    return saved;
  }
}

module.exports = { CONFIG_FILE, PLUGIN_FILE, VERSION, WordPressCacheControl, safeEqual, tokenHash };
