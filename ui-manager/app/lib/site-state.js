const fs = require("fs");
const path = require("path");
const { atomicWriteFile, atomicWriteJson } = require("./safe-write");

function renderCacheMapContent(data) {
  const sites = Object.entries((data && data.sites) || {}).sort(([left], [right]) => left.localeCompare(right));
  const enabled = ["map $host $site_cache_enabled {", "  default 0;"];
  const versions = ["map $host $site_cache_version {", "  default 1;"];
  for (const [domain, state] of sites) {
    enabled.push(`  ${domain} ${state.fastcgiCache ? 1 : 0};`);
    versions.push(`  ${domain} ${Number(state.cacheVersion || 1)};`);
  }
  enabled.push("}");
  versions.push("}");
  return `${enabled.join("\n")}\n\n${versions.join("\n")}\n`;
}

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

  snapshot() {
    return {
      statePath: this.path,
      stateExists: fs.existsSync(this.path),
      stateContent: fs.existsSync(this.path) ? fs.readFileSync(this.path, "utf8") : "",
      cacheMapExists: fs.existsSync(this.cacheMapPath),
      cacheMapContent: fs.existsSync(this.cacheMapPath) ? fs.readFileSync(this.cacheMapPath, "utf8") : "",
    };
  }

  restore(snapshot) {
    if (snapshot.stateExists) atomicWriteFile(snapshot.statePath, snapshot.stateContent, 0o600);
    else if (fs.existsSync(snapshot.statePath)) fs.rmSync(snapshot.statePath, { force: true });
    if (snapshot.cacheMapExists) atomicWriteFile(this.cacheMapPath, snapshot.cacheMapContent, 0o600);
    else if (fs.existsSync(this.cacheMapPath)) fs.rmSync(this.cacheMapPath, { force: true });
  }

  // Builds cache.map content deterministically from the site-state model.
  renderCacheMapContent(data = this.read()) {
    return renderCacheMapContent(data);
  }

  renderCacheMap(data = this.read()) {
    fs.mkdirSync(path.dirname(this.cacheMapPath), { recursive: true });
    atomicWriteFile(this.cacheMapPath, this.renderCacheMapContent(data), 0o600);
  }

  // Atomically persists both site-state.json and the generated cache.map so a
  // failed write restores both files and never leaves them diverged.
  write(data) {
    const snap = this.snapshot();
    try {
      atomicWriteJson(this.path, data, 0o600);
      this.renderCacheMap(data);
    } catch (error) {
      try {
        this.restore(snap);
      } catch { /* best-effort restore */ }
      throw error;
    }
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
      databaseName: "",
      databaseUser: "",
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
}

module.exports = { SiteState, renderCacheMapContent };
