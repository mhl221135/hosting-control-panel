const fs = require("fs");
const path = require("path");

class SiteState {
  constructor(dataDir, cacheMapPath) {
    this.path = path.join(dataDir, "site-state.json");
    this.cacheMapPath = cacheMapPath;
  }

  read() {
    if (!fs.existsSync(this.path)) return { sites: {} };
    try {
      const data = JSON.parse(fs.readFileSync(this.path, "utf8"));
      if (!data.sites || typeof data.sites !== "object") data.sites = {};
      return data;
    } catch {
      return { sites: {} };
    }
  }

  write(data) {
    fs.writeFileSync(this.path, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    this.renderCacheMap(data);
  }

  defaults() {
    return {
      fastcgiCache: false,
      cacheVersion: 1,
      redis: false,
      opcache: true,
      backupEnabled: false,
      imageOptimizationEnabled: false,
      maintenanceEnabled: false,
      siteType: "wordpress",
      notes: "",
    };
  }

  get(domain) {
    return { ...this.defaults(), ...(this.read().sites[domain] || {}) };
  }

  update(domain, patch) {
    const data = this.read();
    const current = this.get(domain);
    data.sites[domain] = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.write(data);
    return data.sites[domain];
  }

  remove(domains) {
    const data = this.read();
    for (const domain of domains) delete data.sites[domain];
    this.write(data);
  }

  purge(domain) {
    const current = this.get(domain);
    return this.update(domain, { cacheVersion: Number(current.cacheVersion || 1) + 1 });
  }

  renderCacheMap(data = this.read()) {
    const sites = Object.entries(data.sites).sort(([left], [right]) => left.localeCompare(right));
    const enabled = ["map $host $site_cache_enabled {", "  default 0;"];
    const versions = ["map $host $site_cache_version {", "  default 1;"];
    for (const [domain, state] of sites) {
      enabled.push(`  ${domain} ${state.fastcgiCache ? 1 : 0};`);
      versions.push(`  ${domain} ${Number(state.cacheVersion || 1)};`);
    }
    enabled.push("}");
    versions.push("}");
    const content = `${enabled.join("\n")}\n\n${versions.join("\n")}\n`;
    fs.mkdirSync(path.dirname(this.cacheMapPath), { recursive: true });
    fs.writeFileSync(this.cacheMapPath, content, "utf8");
  }
}

module.exports = { SiteState };
