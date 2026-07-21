const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFile, spawn } = require("child_process");
const { pipeline } = require("stream/promises");
const { promisify } = require("util");
const { migrateWordPressUrl, normalizeWordPressPermissions, validateDomain } = require("./provisioner");
const {
  parsePools,
  parseSitesMap,
  renderPools,
  renderSitesMap,
  sanitizeSectionName,
  setPoolOpcache,
} = require("./runtime-config");

const execFileAsync = promisify(execFile);
const DATABASE_PATTERN = /^[A-Za-z0-9_$-]{1,32}$/;
const DEFAULT_PRESETS = {
  low: { pm: "ondemand", max_children: "3", start_servers: "1", min_spare_servers: "1", max_spare_servers: "2", process_idle_timeout: "20s", max_requests: "400" },
  medium: { pm: "ondemand", max_children: "6", start_servers: "1", min_spare_servers: "1", max_spare_servers: "2", process_idle_timeout: "30s", max_requests: "500" },
  high: { pm: "dynamic", max_children: "10", start_servers: "2", min_spare_servers: "2", max_spare_servers: "4", process_idle_timeout: "45s", max_requests: "700" },
};

function transferId(date = new Date()) {
  return `export-${date.toISOString().replace(/T/, "_").replace(/:\d{2}\.\d{3}Z$/, "").replaceAll(":", "-")}`;
}

function dumpTimestamp(date = new Date()) {
  return date.toISOString().replace(/T/, "_").replace(/:\d{2}\.\d{3}Z$/, "").replaceAll(":", "-");
}

function safeRelative(value, label = "path") {
  const normalized = path.posix.normalize(String(value || "").replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function resolveInside(root, relative, label = "path") {
  const safe = safeRelative(relative, label);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, safe);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Invalid ${label}`);
  return resolved;
}

function validateDatabaseName(value) {
  const name = String(value || "").trim();
  if (!DATABASE_PATTERN.test(name)) throw new Error(`Database name '${name}' cannot also be used as a MySQL user`);
  return name;
}

function newestDatabaseDump(directory, database) {
  const name = validateDatabaseName(database);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const timestamped = new RegExp(`^${escaped}_\\d{4}-\\d{2}-\\d{2}[T_]\\d{2}-\\d{2}(?:-\\d{2})?\\.sql\\.gz$`);
  const matches = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql.gz"))
    .filter((entry) => entry.name === `${name}.sql.gz` || timestamped.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  return matches.length ? path.join(directory, matches[0]) : "";
}

function validateIpv4(value) {
  const parts = String(value || "").trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new Error("Enter a valid IPv4 WAN address");
  }
  return parts.join(".");
}

function validateManifest(payload) {
  if (!payload || payload.version !== 1 || payload.type !== "hosting-sites-export" || !Array.isArray(payload.sites)) {
    throw new Error("Unsupported or invalid migration manifest");
  }
  const domains = new Set();
  const sites = payload.sites.map((raw) => {
    const domain = validateDomain(raw.domain);
    if (domains.has(domain)) throw new Error(`Duplicate domain in manifest: ${domain}`);
    domains.add(domain);
    const aliases = [...new Set((raw.aliases || []).map(validateDomain))].filter((alias) => alias !== domain);
    aliases.forEach((alias) => {
      if (domains.has(alias)) throw new Error(`Duplicate domain in manifest: ${alias}`);
      domains.add(alias);
    });
    return {
      domain,
      aliases,
      canonicalAliases: [...new Set((raw.canonicalAliases || []).map(validateDomain))]
        .filter((alias) => aliases.includes(alias)),
      websitePath: safeRelative(raw.websitePath, "website path"),
      database: validateDatabaseName(raw.database),
      websiteArchive: raw.websiteArchive ? safeRelative(raw.websiteArchive, "website archive") : "",
      databaseDump: safeRelative(raw.databaseDump, "database dump"),
      poolTier: ["low", "medium", "high"].includes(raw.poolTier) ? raw.poolTier : "medium",
      state: raw.state && typeof raw.state === "object" ? raw.state : {},
    };
  });
  return { ...payload, sites };
}

function validateImportPlan(payload) {
  if (!payload || payload.version !== 1 || payload.type !== "hosting-sites-import" || !Array.isArray(payload.sites)) {
    throw new Error("Unsupported or invalid lightweight import JSON");
  }
  const domains = new Set();
  const sites = payload.sites.map((raw) => {
    const domain = validateDomain(raw.domain);
    if (domains.has(domain)) throw new Error(`Duplicate domain in import JSON: ${domain}`);
    domains.add(domain);
    const aliases = [...new Set((raw.aliases || []).map(validateDomain))].filter((alias) => alias !== domain);
    aliases.forEach((alias) => {
      if (domains.has(alias)) throw new Error(`Duplicate domain in import JSON: ${alias}`);
      domains.add(alias);
    });
    return {
      domain,
      aliases,
      canonicalAliases: [...new Set((raw.canonicalAliases || []).map(validateDomain))]
        .filter((alias) => aliases.includes(alias)),
      websitePath: safeRelative(raw.websitePath, "website path"),
      poolTier: ["low", "medium", "high"].includes(raw.poolTier) ? raw.poolTier : "medium",
      state: {
        opcache: raw.state?.opcache !== false,
        redis: Boolean(raw.state?.redis),
        fastcgiCache: Boolean(raw.state?.fastcgiCache),
        backupEnabled: raw.state?.backupEnabled !== false,
      },
    };
  });
  if (!sites.length) throw new Error("Lightweight import JSON contains no websites");
  return { ...payload, sites };
}

class MigrationManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.exportsRoot = options.exportsRoot;
    this.websitesRoot = options.websitesRoot;
    this.sitesMapPath = options.sitesMapPath;
    this.poolsPath = options.poolsPath;
    this.mysqlContainer = options.mysqlContainer || "hosting-db";
    this.phpContainer = options.phpContainer || "hosting-php-fpm";
    this.npm = options.npm;
    this.cloudflare = options.cloudflare;
    this.siteState = options.siteState;
    fs.mkdirSync(this.exportsRoot, { recursive: true });
  }

  readRuntime() {
    return {
      map: parseSitesMap(fs.readFileSync(this.sitesMapPath, "utf8")),
      pools: parsePools(fs.readFileSync(this.poolsPath, "utf8")),
    };
  }

  primarySites() {
    const runtime = this.readRuntime();
    const groups = new Map();
    for (const site of Object.values(runtime.map.hosts).filter((candidate) => candidate.root && candidate.port)) {
      const key = `${site.root}\u0000${site.port}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(site);
    }
    return [...groups.values()].map((group) => {
        const canonicalTarget = group.find((candidate) =>
          group.some((other) => other.canonicalTo === candidate.host));
        const site = canonicalTarget || [...group].sort((left, right) => {
          const leftWww = left.host.startsWith("www.") ? 1 : 0;
          const rightWww = right.host.startsWith("www.") ? 1 : 0;
          return leftWww - rightWww || left.host.length - right.host.length || left.host.localeCompare(right.host);
        })[0];
        const aliases = group.filter((candidate) => candidate.host !== site.host).map((candidate) => candidate.host).sort();
        const canonicalAliases = group
          .filter((candidate) => candidate.host !== site.host && candidate.canonicalTo === site.host)
          .map((candidate) => candidate.host)
          .sort();
        const pool = runtime.pools.byPort[site.port]?.settings || {};
        const maxChildren = Number(pool["pm.max_children"] || 0);
        const poolTier = maxChildren <= 3 ? "low" : maxChildren <= 6 ? "medium" : "high";
        return { ...site, aliases, canonicalAliases, poolTier, state: this.siteState.get(site.host) };
      }).sort((left, right) => left.host.localeCompare(right.host));
  }

  websiteRelative(site) {
    const root = String(site.root || "").replace(/\/+$/, "");
    if (!root.startsWith("/var/www/")) throw new Error(`Unsupported website root for ${site.host}`);
    return safeRelative(root.slice("/var/www/".length), "website path");
  }

  async wordpressDatabase(websitePath) {
    const { stdout } = await execFileAsync("docker", [
      "exec", "-u", "33:33", this.phpContainer, "wp", "--allow-root", "config", "get", "DB_NAME",
      `--path=/var/www/${safeRelative(websitePath, "website path")}`, "--quiet",
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return validateDatabaseName(stdout.trim());
  }

  async exportAll(selectedDomains = []) {
    const selected = new Set(selectedDomains.map(validateDomain));
    const sites = this.primarySites().filter((site) =>
      selected.size === 0 || selected.has(site.host) || site.aliases.some((alias) => selected.has(alias)));
    if (!sites.length) throw new Error("No configured primary websites were selected for export");
    const id = transferId();
    const partial = path.join(this.exportsRoot, `.partial-${id}`);
    const complete = path.join(this.exportsRoot, id);
    fs.mkdirSync(path.join(partial, "sites"), { recursive: true });
    fs.mkdirSync(path.join(partial, "databases"), { recursive: true });
    const manifestSites = [];
    try {
      for (const site of sites) {
        const websitePath = this.websiteRelative(site);
        const source = resolveInside(this.websitesRoot, websitePath, "website path");
        if (!fs.existsSync(path.join(source, "wp-config.php"))) throw new Error(`wp-config.php not found for ${site.host}`);
        const database = await this.wordpressDatabase(websitePath);
        const slug = sanitizeSectionName(site.host);
        const websiteArchive = `sites/${slug}.tar.gz`;
        const databaseDump = `databases/${database}_${dumpTimestamp()}.sql.gz`;
        await execFileAsync("tar", ["--ignore-failed-read", "--warning=no-file-changed", "-czf", path.join(partial, websiteArchive), "-C", this.websitesRoot, websitePath], { timeout: 4 * 60 * 60 * 1000, maxBuffer: 1024 * 1024 });
        await this.dumpDatabase(database, path.join(partial, databaseDump));
        manifestSites.push({
          domain: site.host,
          aliases: site.aliases,
          canonicalAliases: site.canonicalAliases,
          websitePath,
          database,
          websiteArchive,
          databaseDump,
          poolTier: site.poolTier,
          state: {
            fastcgiCache: Boolean(site.state.fastcgiCache),
            redis: Boolean(site.state.redis),
            opcache: site.state.opcache !== false,
            backupEnabled: Boolean(site.state.backupEnabled),
          },
        });
      }
      const manifest = {
        version: 1,
        type: "hosting-sites-export",
        id,
        createdAt: new Date().toISOString(),
        sites: manifestSites,
      };
      fs.writeFileSync(path.join(partial, "manifest.json"), JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(partial, complete);
      return { directory: complete, manifest };
    } catch (error) {
      fs.rmSync(partial, { recursive: true, force: true });
      throw error;
    }
  }

  async dumpDatabase(database, outputPath) {
    const child = spawn("docker", [
      "exec", this.mysqlContainer, "sh", "-c",
      'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec nice -n 10 mysqldump -uroot --single-transaction --quick --routines --events --triggers --hex-blob "$1"',
      "migration-dump", validateDatabaseName(database),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    await this.pipeDatabaseProcess(child, zlib.createGzip({ level: 6 }), fs.createWriteStream(outputPath, { mode: 0o600 }), "export");
  }

  async pipeDatabaseProcess(child, transform, destination, operation) {
    let stderr = "";
    child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk.toString(); });
    await Promise.all([
      pipeline(child.stdout, transform, destination),
      new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Database ${operation} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`)));
      }),
    ]);
  }

  discoverCopiedSites() {
    const configured = new Set(this.primarySites().map((site) => this.websiteRelative(site)));
    const found = [];
    const walk = (directory, relative = "", depth = 0) => {
      if (depth > 4) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "_default") continue;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const child = path.join(directory, entry.name);
        if (fs.existsSync(path.join(child, "wp-config.php"))) {
          if (!configured.has(childRelative)) found.push({ websitePath: childRelative });
          continue;
        }
        walk(child, childRelative, depth + 1);
      }
    };
    walk(this.websitesRoot);
    return found.sort((left, right) => left.websitePath.localeCompare(right.websitePath));
  }

  readManifest(sourceDirectory) {
    const manifestPath = path.join(sourceDirectory, "manifest.json");
    return validateManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  }

  verifyArchive(archivePath, websitePath) {
    return execFileAsync("tar", ["-tzf", archivePath], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) => {
      const expected = `${safeRelative(websitePath, "website path")}/`;
      for (const raw of stdout.split("\n").filter(Boolean)) {
        const item = raw.replace(/^\.\//, "");
        if (path.posix.isAbsolute(item) || item.includes("../") || (item !== expected.slice(0, -1) && !item.startsWith(expected))) {
          throw new Error(`Archive contains an unsafe path: ${raw}`);
        }
      }
    });
  }

  async prepareWebsite(site, sourceDirectory, useExistingFiles) {
    const destination = resolveInside(this.websitesRoot, site.websitePath, "website path");
    let extracted = false;
    if (site.websiteArchive) {
      if (fs.existsSync(destination) && fs.readdirSync(destination).length) {
        if (!useExistingFiles) throw new Error(`Website directory is not empty: ${site.websitePath}`);
      } else {
        const archive = resolveInside(sourceDirectory, site.websiteArchive, "website archive");
        await this.verifyArchive(archive, site.websitePath);
        await execFileAsync("tar", ["-xzf", archive, "-C", this.websitesRoot], { timeout: 4 * 60 * 60 * 1000, maxBuffer: 1024 * 1024 });
        extracted = true;
      }
    }
    if (!fs.existsSync(path.join(destination, "wp-config.php"))) throw new Error(`wp-config.php not found in ${site.websitePath}`);
    return { destination, extracted };
  }

  async databaseExists(database) {
    const sql = `SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='${database}'`;
    const { stdout } = await execFileAsync("docker", [
      "exec", "-e", `MIGRATION_SQL=${sql}`, this.mysqlContainer, "sh", "-c",
      'exec mysql -N -uroot -p"$MYSQL_ROOT_PASSWORD" -e "$MIGRATION_SQL"',
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return stdout.trim() !== "0";
  }

  async createDatabaseUser(database, password) {
    validateDatabaseName(database);
    const sql = [
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      `CREATE USER '${database}'@'%' IDENTIFIED BY '${password}'`,
      `GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${database}'@'%'`,
      "FLUSH PRIVILEGES",
    ].join("; ");
    try {
      await execFileAsync("docker", [
        "exec", "-e", `MIGRATION_SQL=${sql}`, this.mysqlContainer, "sh", "-c",
        'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "$MIGRATION_SQL"',
      ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      await this.dropDatabaseUser(database).catch(() => {});
      throw error;
    }
  }

  async dropDatabaseUser(database) {
    validateDatabaseName(database);
    const sql = `DROP DATABASE IF EXISTS \`${database}\`; DROP USER IF EXISTS '${database}'@'%'; FLUSH PRIVILEGES`;
    await execFileAsync("docker", [
      "exec", "-e", `MIGRATION_SQL=${sql}`, this.mysqlContainer, "sh", "-c",
      'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "$MIGRATION_SQL"',
    ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  }

  async importDatabase(database, inputPath) {
    const child = spawn("docker", [
      "exec", "-i", this.mysqlContainer, "sh", "-c",
      'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec nice -n 10 mysql -uroot "$1"',
      "migration-import", validateDatabaseName(database),
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk.toString(); });
    await Promise.all([
      pipeline(fs.createReadStream(inputPath), zlib.createGunzip(), child.stdin),
      new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Database import failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`)));
      }),
    ]);
  }

  async updateWordPressDatabase(site, database, password) {
    await normalizeWordPressPermissions(site.websitePath);
    const wpPath = `/var/www/${site.websitePath}`;
    for (const [key, value] of [["DB_NAME", database], ["DB_USER", database], ["DB_PASSWORD", password], ["DB_HOST", "hosting-db"]]) {
      await execFileAsync("docker", ["exec", "-u", "33:33", this.phpContainer, "wp", "--allow-root", "config", "set", key, value, "--type=constant", `--path=${wpPath}`], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    }
  }

  readPresets() {
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(this.dataDir, "pool-presets.json"), "utf8"));
      return { ...DEFAULT_PRESETS, ...stored };
    } catch {
      return DEFAULT_PRESETS;
    }
  }

  configureRuntime(sites) {
    const mapBefore = fs.readFileSync(this.sitesMapPath, "utf8");
    const poolsBefore = fs.readFileSync(this.poolsPath, "utf8");
    const map = parseSitesMap(mapBefore);
    const pools = parsePools(poolsBefore);
    const presets = this.readPresets();
    const usedPorts = Object.values(pools.sections).map((pool) => Number(pool.listen)).filter(Number.isInteger);
    let nextPort = Math.max(9000, ...usedPorts) + 1;
    const configured = [];
    for (const site of sites) {
      const allDomains = [site.domain, ...site.aliases];
      for (const domain of allDomains) {
        if (map.hosts[domain]) throw new Error(`Domain is already configured: ${domain}`);
      }
      const port = nextPort++;
      const poolName = sanitizeSectionName(site.domain);
      if (pools.sections[poolName]) throw new Error(`PHP pool already exists: ${poolName}`);
      const tier = presets[site.poolTier] || presets.medium || DEFAULT_PRESETS.medium;
      const root = `/var/www/${site.websitePath}`;
      pools.sections[poolName] = setPoolOpcache({
        user: "www-data", group: "www-data", listen: String(port), pm: String(tier.pm),
        "pm.max_children": String(tier.max_children), "pm.start_servers": String(tier.start_servers),
        "pm.min_spare_servers": String(tier.min_spare_servers), "pm.max_spare_servers": String(tier.max_spare_servers),
        "pm.process_idle_timeout": String(tier.process_idle_timeout), "pm.max_requests": String(tier.max_requests),
        "php_admin_value[open_basedir]": `${root}/:/global/:/tmp/`,
        clear_env: "no", catch_workers_output: "yes", request_terminate_timeout: "120s",
      }, site.state.opcache !== false);
      pools.sectionOrder.push(poolName);
      map.hosts[site.domain] = { host: site.domain, root, port, upstream: `hosting-php-fpm:${port}`, canonicalTo: "" };
      for (const alias of site.aliases) {
        map.hosts[alias] = {
          host: alias,
          root,
          port,
          upstream: `hosting-php-fpm:${port}`,
          canonicalTo: site.canonicalAliases.includes(alias) ? site.domain : "",
        };
      }
      configured.push({ ...site, port, poolName });
    }
    fs.writeFileSync(this.sitesMapPath, renderSitesMap(map), "utf8");
    fs.writeFileSync(this.poolsPath, renderPools(pools), "utf8");
    return { configured, mapBefore, poolsBefore };
  }

  async validateAndReload(runtimeChange) {
    try {
      await execFileAsync("docker", ["exec", "hosting-nginx", "nginx", "-t"], { timeout: 30_000 });
      await execFileAsync("docker", ["exec", this.phpContainer, "php-fpm", "-t"], { timeout: 30_000 });
      await execFileAsync("docker", ["exec", "hosting-nginx", "nginx", "-s", "reload"], { timeout: 30_000 });
      await execFileAsync("docker", ["exec", this.phpContainer, "sh", "-c", "kill -USR2 1"], { timeout: 30_000 });
    } catch (error) {
      fs.writeFileSync(this.sitesMapPath, runtimeChange.mapBefore, "utf8");
      fs.writeFileSync(this.poolsPath, runtimeChange.poolsBefore, "utf8");
      throw error;
    }
  }

  async importSites(options) {
    const sourceDirectory = path.resolve(options.sourceDirectory);
    const manifest = options.manifest ? validateManifest(options.manifest) : this.readManifest(sourceDirectory);
    const wanIp = options.updateDns === false ? "" : validateIpv4(options.wanIp);
    const prepared = [];
    const createdDatabases = [];
    const preparedFiles = [];
    let runtimeChange;
    try {
      for (const site of manifest.sites) {
        const website = await this.prepareWebsite(site, sourceDirectory, Boolean(options.useExistingFiles));
        const configPath = path.join(website.destination, "wp-config.php");
        preparedFiles.push({
          configPath,
          configContent: website.extracted ? null : fs.readFileSync(configPath),
          extractedDirectory: website.extracted ? website.destination : "",
        });
        const configuredDatabase = await this.wordpressDatabase(site.websitePath);
        const database = validateDatabaseName(site.database || configuredDatabase);
        if (await this.databaseExists(database)) throw new Error(`Database already exists: ${database}`);
        const dumpPath = site.databaseDump
          ? resolveInside(sourceDirectory, site.databaseDump, "database dump")
          : newestDatabaseDump(sourceDirectory, configuredDatabase);
        if (!dumpPath || !fs.existsSync(dumpPath)) throw new Error(`Database dump not found for ${site.domain} (${configuredDatabase})`);
        const password = crypto.randomBytes(24).toString("base64url");
        await this.createDatabaseUser(database, password);
        createdDatabases.push(database);
        await this.importDatabase(database, dumpPath);
        await this.updateWordPressDatabase(site, database, password);
        prepared.push({ ...site, database, password });
      }

      runtimeChange = this.configureRuntime(prepared);
      await this.validateAndReload(runtimeChange);
    } catch (error) {
      const cleanupErrors = [];
      for (const database of [...createdDatabases].reverse()) {
        try {
          await this.dropDatabaseUser(database);
        } catch (cleanupError) {
          cleanupErrors.push(`${database}: ${cleanupError.message}`);
        }
      }
      for (const website of [...preparedFiles].reverse()) {
        try {
          if (website.extractedDirectory) fs.rmSync(website.extractedDirectory, { recursive: true, force: true });
          else if (website.configContent) fs.writeFileSync(website.configPath, website.configContent);
        } catch (cleanupError) {
          cleanupErrors.push(`${website.configPath}: ${cleanupError.message}`);
        }
      }
      if (cleanupErrors.length) error.message += `; recovery cleanup failed (${cleanupErrors.join(", ")})`;
      throw error;
    }
    const results = [];
    for (const site of runtimeChange.configured) {
      const domains = [site.domain, ...site.aliases];
      const warnings = [];
      if (options.updateDns !== false) {
        for (const domain of domains) {
          try {
            await this.cloudflare.upsertHostAddress(domain, wanIp, options.proxied !== false);
          } catch (error) {
            warnings.push(`Cloudflare ${domain}: ${error.message}`);
          }
        }
      }
      let npmHost = null;
      if (options.createNpmHost !== false) {
        try {
          npmHost = await this.npm.ensureHost(domains, options.issueSsl !== false);
        } catch (error) {
          warnings.push(`NPM/SSL: ${error.message}`);
        }
      }
      try {
        await migrateWordPressUrl(site.websitePath, site.domain, Boolean(npmHost?.certificate_id));
      } catch (error) {
        warnings.push(`WordPress URL: ${error.message}`);
      }
      this.siteState.update(site.domain, {
        fastcgiCache: Boolean(site.state.fastcgiCache), redis: Boolean(site.state.redis),
        opcache: site.state.opcache !== false, backupEnabled: Boolean(site.state.backupEnabled), cacheVersion: 1,
      });
      results.push({
        domain: site.domain,
        aliases: site.aliases,
        websitePath: site.websitePath,
        database: site.database,
        databasePassword: options.includeCredentials ? site.password : undefined,
        port: site.port,
        warnings,
      });
    }
    await execFileAsync("docker", ["exec", "hosting-nginx", "nginx", "-s", "reload"], { timeout: 30_000 });
    return { ok: results.every((result) => result.warnings.length === 0), results };
  }
}

module.exports = {
  MigrationManager,
  dumpTimestamp,
  newestDatabaseDump,
  resolveInside,
  safeRelative,
  transferId,
  validateDatabaseName,
  validateImportPlan,
  validateIpv4,
  validateManifest,
};
