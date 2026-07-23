const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { exec, execFile } = require("child_process");
const { AuthStore } = require("./lib/auth");
const { IntegrationSettings } = require("./lib/integration-settings");
const { CloudflareClient, NpmClient } = require("./lib/integrations");
const {
  createDatabase,
  dropDatabaseAndUser,
  installWordPress,
  mysqlIdentifier,
  normalizeWordPressPermissions,
  optimizeImages,
  prepareSiteDirectory,
  randomPassword,
  removeSiteDirectory,
  setRedis,
  updateWordPressUrl,
  validateDomain,
  wordpressDatabaseConfig,
} = require("./lib/provisioner");
const { SiteState } = require("./lib/site-state");
const { supportsWordPressRedis } = require("./lib/site-capabilities");
const { BackupManager } = require("./lib/backup-manager");
const { DnsPresetStore } = require("./lib/dns-presets");
const { IpAddressStore, validateIpv4 } = require("./lib/ip-addresses");
const { PerformanceSettings } = require("./lib/performance-settings");
const { annotateSiteAliases, setPoolOpcache } = require("./lib/runtime-config");
const { ImageOptimizationManager } = require("./lib/image-optimization-manager");
const { resolvePublicFile } = require("./lib/static-files");
const { WordPressPackageStore } = require("./lib/wordpress-packages");
const { StatsCollector } = require("./lib/stats-collector");
const { buildSiteRemovalPlan } = require("./lib/site-removal-plan");
const { jobInput: siteRemovalJobInput, parseSelection: parseSiteRemovalSelection, validateSelection: validateSiteRemovalSelection } = require("./lib/site-removal-job");
const { MigrationManager, safeRelative } = require("./lib/migration-manager");
const { ProvisionImportStore } = require("./lib/provision-import-store");
const { MaintenanceManager } = require("./lib/maintenance-manager");
const { WordPressMaintenanceRunner } = require("./lib/wordpress-maintenance");
const { JobManager } = require("./lib/job-manager");
const { NotificationSettings } = require("./lib/notification-settings");
const { NotificationManager } = require("./lib/notification-manager");
const { HealthSettings } = require("./lib/health-settings");
const { HealthMonitor } = require("./lib/health-monitor");
const { OneTimeVault } = require("./lib/one-time-vault");
const { jobInput: provisioningJobInput, jobResult: provisioningJobResult, safeProvisionPayload } = require("./lib/provisioning-job");
const { IpinfoClient } = require("./lib/ipinfo-client");
const { CertificateJobManager } = require("./lib/certificate-job-manager");
const { provisionSecurityStep, selectedProvisionSecurity } = require("./lib/provision-security");

const PORT = Number(process.env.PORT || 8687);
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const SITES_MAP_PATH = process.env.SITES_MAP_PATH || "/srv/configs/nginx/conf.d/sites.map";
const POOLS_PATH = process.env.POOLS_PATH || "/srv/configs/php-fpm/pools.conf";
const DEFAULT_POOL_PATH = path.join(DATA_DIR, "default-pool.json");
const PRESETS_PATH = path.join(DATA_DIR, "pool-presets.json");
const CACHE_MAP_PATH = process.env.CACHE_MAP_PATH || "/srv/configs/nginx/conf.d/cache.map";
const WEBSITES_ROOT = process.env.WEBSITES_ROOT || "/srv/websites";
const APP_DATA_ROOT = process.env.APP_DATA_ROOT || "/srv/app-data";
const BACKUPS_ROOT = process.env.BACKUPS_ROOT || "/srv/backups";
const EXPORTS_ROOT = process.env.EXPORTS_ROOT || "/srv/exports";
const IMPORTS_ROOT = process.env.IMPORTS_ROOT || "/srv/imports";
const EXPORT_DOWNLOAD_MAX_BYTES = Number(process.env.EXPORT_DOWNLOAD_MAX_BYTES || 512 * 1024 * 1024);
const DEFAULT_PHP_UPSTREAM = process.env.DEFAULT_PHP_UPSTREAM || "hosting-php-fpm:9000";
const PHP_INI_PATH = process.env.PHP_INI_PATH || "/srv/configs/php/global.ini";
const NGINX_CONFIG_PATH = process.env.NGINX_CONFIG_PATH || "/srv/configs/nginx/nginx.conf";
const NGINX_DEFAULT_PATH = process.env.NGINX_DEFAULT_PATH || "/srv/configs/nginx/conf.d/default.conf";

const ACTION_CMDS = {
  reload_nginx: process.env.RELOAD_NGINX_CMD || "",
  reload_php: process.env.RELOAD_PHP_CMD || "",
  clear_opcache: process.env.CLEAR_OPCACHE_CMD || "",
};

const DEFAULT_POOL_PRESETS = {
  low: {
    pm: "ondemand",
    max_children: "2",
    start_servers: "1",
    min_spare_servers: "1",
    max_spare_servers: "2",
    process_idle_timeout: "20s",
    max_requests: "400",
  },
  medium: {
    pm: "ondemand",
    max_children: "6",
    start_servers: "1",
    min_spare_servers: "1",
    max_spare_servers: "2",
    process_idle_timeout: "30s",
    max_requests: "500",
  },
  high: {
    pm: "dynamic",
    max_children: "10",
    start_servers: "2",
    min_spare_servers: "2",
    max_spare_servers: "4",
    process_idle_timeout: "45s",
    max_requests: "700",
  },
};

fs.mkdirSync(DATA_DIR, { recursive: true });
const auth = new AuthStore(DATA_DIR);
const integrationSettings = new IntegrationSettings(DATA_DIR);
const cloudflare = new CloudflareClient(() => integrationSettings.resolved());
const npm = new NpmClient(() => integrationSettings.resolved(), { certificateDns: cloudflare });
const cloudflareSecurity = new CloudflareClient(() => integrationSettings.resolved(), {
  tokenSetting: "cloudflareSecurityToken",
  tokenEnvironment: "CLOUDFLARE_SECURITY_API_TOKEN",
  integrationName: "Cloudflare Security",
});
const dnsPresets = new DnsPresetStore(DATA_DIR);
const wordpressPackages = new WordPressPackageStore(DATA_DIR);
const ipAddresses = new IpAddressStore(DATA_DIR);
const ipinfo = new IpinfoClient({ dataDir: DATA_DIR, settings: () => integrationSettings.resolved() });
const performanceSettings = new PerformanceSettings({
  dataDir: DATA_DIR,
  phpIniPath: PHP_INI_PATH,
  nginxPath: NGINX_CONFIG_PATH,
  nginxDefaultPath: NGINX_DEFAULT_PATH,
});
const siteState = new SiteState(DATA_DIR, CACHE_MAP_PATH);
siteState.renderCacheMap();
const jobManager = new JobManager({
  dataDir: DATA_DIR,
  historyLimit: Number(process.env.JOB_HISTORY_LIMIT || 250),
});
const certificateJobManager = new CertificateJobManager({ jobManager, npm });
const notificationSettings = new NotificationSettings(DATA_DIR);
const notificationManager = new NotificationManager({
  dataDir: DATA_DIR,
  settings: notificationSettings,
  maxHistory: Number(process.env.NOTIFICATION_HISTORY_LIMIT || 500),
});
const healthSettings = new HealthSettings(DATA_DIR);
const backupManager = new BackupManager({
  dataDir: DATA_DIR,
  backupsRoot: BACKUPS_ROOT,
  websitesRoot: WEBSITES_ROOT,
  appDataRoot: APP_DATA_ROOT,
  mysqlContainer: process.env.MYSQL_CONTAINER || "hosting-db",
  phpContainer: process.env.PHP_CONTAINER || "hosting-php-fpm",
  jobManager,
  siteProvider: async () => {
    const mapParsed = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
    const poolsParsed = parsePools(fs.readFileSync(POOLS_PATH, "utf8"));
    return getSitesWithPools(mapParsed, poolsParsed);
  },
});
const imageOptimizationManager = new ImageOptimizationManager({
  dataDir: DATA_DIR,
  backupManager,
  jobManager,
  optimizer: optimizeImages,
  siteProvider: async () => {
    const mapParsed = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
    const poolsParsed = parsePools(fs.readFileSync(POOLS_PATH, "utf8"));
    return getSitesWithPools(mapParsed, poolsParsed).map((site) => ({
      ...site,
      directory: String(site.root || "").replace(/^\/var\/www\//, "").replace(/\/$/, ""),
    }));
  },
});
const maintenanceManager = new MaintenanceManager({
  dataDir: DATA_DIR,
  backupManager,
  jobManager,
  runner: new WordPressMaintenanceRunner({ phpContainer: process.env.PHP_CONTAINER || "hosting-php-fpm" }),
  siteProvider: async () => {
    const mapParsed = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
    const poolsParsed = parsePools(fs.readFileSync(POOLS_PATH, "utf8"));
    return getSitesWithPools(mapParsed, poolsParsed)
      .filter((site) => !site.isAlias)
      .map((site) => ({
        ...site,
        directory: String(site.root || "").replace(/^\/var\/www\//, "").replace(/\/$/, ""),
      }));
  },
  afterRun: async (domains) => {
    for (const domain of domains) siteState.purge(domain);
    await execCommand("docker exec hosting-nginx nginx -s reload");
  },
});
const statsCollector = new StatsCollector({
  websitesRoot: WEBSITES_ROOT,
  npmLogsRoot: path.join(APP_DATA_ROOT, "npm/data/logs"),
});
const healthMonitor = new HealthMonitor({
  dataDir: DATA_DIR,
  websitesRoot: WEBSITES_ROOT,
  backupsRoot: BACKUPS_ROOT,
  settings: healthSettings,
  notificationManager,
  statsCollector,
  npm,
  maxHistory: Number(process.env.HEALTH_HISTORY_LIMIT || 250),
});
const provisionImports = new ProvisionImportStore({ importsRoot: IMPORTS_ROOT });
const provisioningVault = new OneTimeVault({
  dataDir: DATA_DIR,
  ttlHours: process.env.PROVISION_CREDENTIAL_TTL_HOURS || 24,
});
const migrationManager = new MigrationManager({
  dataDir: DATA_DIR,
  exportsRoot: EXPORTS_ROOT,
  websitesRoot: WEBSITES_ROOT,
  sitesMapPath: SITES_MAP_PATH,
  poolsPath: POOLS_PATH,
  mysqlContainer: process.env.MYSQL_CONTAINER || "hosting-db",
  phpContainer: process.env.PHP_CONTAINER || "hosting-php-fpm",
  npm,
  cloudflare,
  siteState,
});
jobManager.register("sites.export", async (context, payload) =>
  backupManager.withLock({ type: "export", label: "Portable website export" }, async () => {
    const result = await migrationManager.exportAll(payload.domains, {
      checkpoint: context.checkpoint,
      onProgress: context.update,
    });
    return {
      ok: result.ok,
      exportId: result.exportId,
      results: result.results,
      total: result.total,
      completed: result.completed,
      message: result.message,
    };
  }));

function decorateJob(job, operator) {
  return job ? { ...job, oneTimeAccessAvailable: provisioningVault.has(job.id, operator) } : null;
}

async function collectSiteStats(domain, force = false) {
  const mapParsed = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
  const poolsParsed = parsePools(fs.readFileSync(POOLS_PATH, "utf8"));
  const site = getSitesWithPools(mapParsed, poolsParsed).find((item) => item.host === domain && !item.isAlias);
  if (!site) throw Object.assign(new Error("Primary site is not configured"), { statusCode: 404 });
  let npmHostIds = [];
  if (npm.configured()) {
    try {
      const names = new Set([site.host, ...(site.aliases || [])]);
      npmHostIds = (await npm.listHosts())
        .filter((host) => (host.domain_names || []).some((name) => names.has(name)))
        .map((host) => host.id);
    } catch (error) {
      console.error(`Could not map NPM logs for ${domain}: ${error.message}`);
    }
  }
  const directory = String(site.root || "").replace(/^\/var\/www\//, "").replace(/\/$/, "");
  return statsCollector.site({ domain, directory, npmHostIds }, force);
}

function sendJson(res, code, obj, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) reject(new Error("Request body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function readBinaryBody(req, limit = 128 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] || 0) > limit) {
      const error = new Error("Upload must be 128 MB or smaller");
      error.statusCode = 413;
      reject(error);
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        const error = new Error("Upload must be 128 MB or smaller");
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

function sanitizeSectionName(host) {
  return host.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "pool";
}

function readPoolPresets() {
  if (!fs.existsSync(PRESETS_PATH)) {
    fs.writeFileSync(PRESETS_PATH, JSON.stringify(DEFAULT_POOL_PRESETS, null, 2), "utf8");
    return JSON.parse(JSON.stringify(DEFAULT_POOL_PRESETS));
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(PRESETS_PATH, "utf8"));
  } catch {
    parsed = {};
  }
  const merged = { ...DEFAULT_POOL_PRESETS };
  for (const [name, preset] of Object.entries(parsed || {})) {
    if (!preset || typeof preset !== "object") continue;
    merged[name] = {
      pm: String(preset.pm || merged[name]?.pm || "ondemand"),
      max_children: String(preset.max_children || merged[name]?.max_children || "4"),
      start_servers: String(preset.start_servers || merged[name]?.start_servers || "1"),
      min_spare_servers: String(preset.min_spare_servers || merged[name]?.min_spare_servers || "1"),
      max_spare_servers: String(preset.max_spare_servers || merged[name]?.max_spare_servers || "2"),
      process_idle_timeout: String(preset.process_idle_timeout || merged[name]?.process_idle_timeout || "30s"),
      max_requests: String(preset.max_requests || merged[name]?.max_requests || "500"),
    };
  }
  return merged;
}

function writePoolPresets(payload) {
  const current = readPoolPresets();
  const out = {};
  for (const [name, preset] of Object.entries(payload || {})) {
    if (!preset || typeof preset !== "object") continue;
    out[name] = {
      pm: String(preset.pm || current[name]?.pm || "ondemand"),
      max_children: String(preset.max_children || current[name]?.max_children || "4"),
      start_servers: String(preset.start_servers || current[name]?.start_servers || "1"),
      min_spare_servers: String(preset.min_spare_servers || current[name]?.min_spare_servers || "1"),
      max_spare_servers: String(preset.max_spare_servers || current[name]?.max_spare_servers || "2"),
      process_idle_timeout: String(preset.process_idle_timeout || current[name]?.process_idle_timeout || "30s"),
      max_requests: String(preset.max_requests || current[name]?.max_requests || "500"),
    };
  }
  for (const requiredName of ["low", "medium", "high"]) {
    if (!out[requiredName]) out[requiredName] = current[requiredName] || DEFAULT_POOL_PRESETS[requiredName];
  }
  fs.writeFileSync(PRESETS_PATH, JSON.stringify(out, null, 2), "utf8");
}

function normalizeTier(tier, presets = readPoolPresets()) {
  const key = String(tier || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(presets, key) ? key : "";
}

function detectTier(pool, presets = readPoolPresets()) {
  if (!pool) return "custom";
  const keys = [
    "pm",
    "pm.max_children",
    "pm.start_servers",
    "pm.min_spare_servers",
    "pm.max_spare_servers",
    "pm.process_idle_timeout",
    "pm.max_requests",
  ];
  for (const [tierName, tier] of Object.entries(presets)) {
    const isMatch = keys.every((k) => {
      const poolValue = String(pool[k] || "").trim();
      const tierKey = k === "pm" ? "pm" : k.replace("pm.", "");
      const tierValue = String(tier[tierKey] || "").trim();
      return poolValue === tierValue;
    });
    if (isMatch) return tierName;
  }
  return "custom";
}

function parseSitesMap(content) {
  const rootBlockMatch = content.match(/map\s+\$host\s+\$site_root\s*\{([\s\S]*?)\n\}/);
  const upstreamBlockMatch = content.match(/map\s+\$host\s+\$php_upstream\s*\{([\s\S]*?)\n\}/);
  const canonicalBlockMatch = content.match(/map\s+\$host\s+\$canonical_host\s*\{([\s\S]*?)\n\}/);
  if (!rootBlockMatch || !upstreamBlockMatch) {
    throw new Error("Could not parse sites.map. Expected both map blocks.");
  }

  const parseBlock = (block) => {
    const entries = {};
    let defaultValue = "";
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^([^\s]+)\s+(.+);$/);
      if (!m) continue;
      if (m[1] === "default") defaultValue = m[2];
      else entries[m[1]] = m[2];
    }
    return { entries, defaultValue };
  };

  const roots = parseBlock(rootBlockMatch[1]);
  const upstreams = parseBlock(upstreamBlockMatch[1]);
  const canonicals = canonicalBlockMatch ? parseBlock(canonicalBlockMatch[1]) : { entries: {}, defaultValue: '""' };
  const hosts = {};
  const allHosts = new Set([
    ...Object.keys(roots.entries),
    ...Object.keys(upstreams.entries),
    ...Object.keys(canonicals.entries),
  ]);

  for (const host of allHosts) {
    const upstream = upstreams.entries[host] || "";
    const portMatch = upstream.match(/:(\d+)$/);
    hosts[host] = {
      host,
      root: roots.entries[host] || "",
      upstream,
      port: portMatch ? Number(portMatch[1]) : null,
      canonicalTo: canonicals.entries[host] || "",
    };
  }

  return {
    defaultRoot: roots.defaultValue || "/var/www/_default",
    defaultUpstream: DEFAULT_PHP_UPSTREAM,
    defaultCanonical: canonicals.defaultValue || '""',
    hosts,
  };
}

function renderSitesMap(parsed) {
  const hosts = Object.keys(parsed.hosts).sort();
  const rootLines = [`map $host $site_root {`, `  default ${parsed.defaultRoot};`];
  const upLines = [`map $host $php_upstream {`, `  default ${parsed.defaultUpstream};`];
  const canonicalLines = [`map $host $canonical_host {`, `  default ${parsed.defaultCanonical || '""'};`];

  for (const host of hosts) {
    const site = parsed.hosts[host];
    if (site.root) rootLines.push(`  ${host} ${site.root};`);
    if (site.upstream) upLines.push(`  ${host} ${site.upstream};`);
    if (site.canonicalTo) canonicalLines.push(`  ${host} ${site.canonicalTo};`);
  }

  rootLines.push("}");
  upLines.push("}");
  canonicalLines.push("}");
  return `${rootLines.join("\n")}\n\n${upLines.join("\n")}\n\n${canonicalLines.join("\n")}\n`;
}

function parsePools(content) {
  const lines = content.split("\n");
  const prefix = [];
  const sections = {};
  const sectionOrder = [];
  let current = null;

  for (const raw of lines) {
    const secMatch = raw.match(/^\s*\[([^\]]+)\]\s*$/);
    if (secMatch) {
      current = secMatch[1];
      if (!sections[current]) {
        sections[current] = {};
        sectionOrder.push(current);
      }
      continue;
    }

    if (!current) {
      prefix.push(raw);
      continue;
    }

    const kv = raw.match(/^\s*([^=;#]+?)\s*=\s*(.*?)\s*$/);
    if (kv) sections[current][kv[1].trim()] = kv[2].trim();
  }

  const byPort = {};
  for (const name of sectionOrder) {
    const listen = sections[name].listen;
    if (!listen) continue;
    const p = Number(listen);
    if (Number.isFinite(p)) byPort[p] = { name, settings: sections[name] };
  }

  return { prefix, sections, sectionOrder, byPort };
}

function renderPools(parsed) {
  const out = [];
  const prefix = parsed.prefix.join("\n").replace(/\s+$/, "");
  if (prefix) out.push(prefix);

  for (const name of parsed.sectionOrder) {
    const settings = parsed.sections[name];
    if (!settings) continue;
    out.push("");
    out.push(`[${name}]`);
    for (const [k, v] of Object.entries(settings)) out.push(`${k} = ${v}`);
  }

  out.push("");
  return out.join("\n");
}

function backupFile(filePath, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.basename(filePath);
  const backupPath = path.join(DATA_DIR, `${base}.${stamp}.bak`);
  fs.writeFileSync(backupPath, content, "utf8");
}

function readDefaultPool() {
  const presets = readPoolPresets();
  if (!fs.existsSync(DEFAULT_POOL_PATH)) {
    return {
      default_tier: "medium",
      pm: "ondemand",
      max_children: "4",
      start_servers: "2",
      min_spare_servers: "1",
      max_spare_servers: "4",
      process_idle_timeout: "30s",
      max_requests: "300",
      user: "www-data",
      group: "www-data",
    };
  }

  const parsed = JSON.parse(fs.readFileSync(DEFAULT_POOL_PATH, "utf8"));
  if (!parsed.default_tier || !normalizeTier(parsed.default_tier, presets)) parsed.default_tier = "medium";
  return parsed;
}

function writeDefaultPool(payload) {
  fs.writeFileSync(DEFAULT_POOL_PATH, JSON.stringify(payload, null, 2), "utf8");
}

function buildPoolSettings({ incomingPool, basePool, defaults, tierName, root, port, presets }) {
  const tier = (presets || {})[tierName] || {};
  const settings = {
    ...basePool,
    user: incomingPool.user || basePool.user || defaults.user || "www-data",
    group: incomingPool.group || basePool.group || defaults.group || "www-data",
    listen: String(port),
    pm: incomingPool.pm || tier.pm || basePool.pm || defaults.pm || "ondemand",
    "pm.max_children": incomingPool.max_children || tier.max_children || basePool["pm.max_children"] || defaults.max_children || "4",
    "pm.start_servers": incomingPool.start_servers || tier.start_servers || basePool["pm.start_servers"] || defaults.start_servers || "2",
    "pm.min_spare_servers":
      incomingPool.min_spare_servers ||
      tier.min_spare_servers ||
      basePool["pm.min_spare_servers"] ||
      defaults.min_spare_servers ||
      "1",
    "pm.max_spare_servers":
      incomingPool.max_spare_servers ||
      tier.max_spare_servers ||
      basePool["pm.max_spare_servers"] ||
      defaults.max_spare_servers ||
      "4",
    "pm.process_idle_timeout":
      incomingPool.process_idle_timeout ||
      tier.process_idle_timeout ||
      basePool["pm.process_idle_timeout"] ||
      defaults.process_idle_timeout ||
      "30s",
    "pm.max_requests": incomingPool.max_requests || tier.max_requests || basePool["pm.max_requests"] || defaults.max_requests || "300",
    "php_admin_value[open_basedir]":
      incomingPool.open_basedir || basePool["php_admin_value[open_basedir]"] || `${root || "/var/www"}/:/global/:/tmp/`,
    clear_env: "no",
    catch_workers_output: "yes",
    request_terminate_timeout: incomingPool.request_terminate_timeout || basePool.request_terminate_timeout || "60s",
  };
  return setPoolOpcache(settings, settings["php_admin_value[opcache.enable]"] !== "0");
}

function execAction(actionKey) {
  const cmd = ACTION_CMDS[actionKey];
  if (!cmd) {
    return Promise.resolve({
      ok: false,
      message: `Action '${actionKey}' is not configured. Set ${actionKey.toUpperCase()}_CMD in docker-compose.`,
      output: "",
    });
  }

  return new Promise((resolve) => {
    exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, message: error.message, output: `${stdout}\n${stderr}`.trim() });
        return;
      }
      resolve({ ok: true, message: "Action completed", output: `${stdout}\n${stderr}`.trim() });
    });
  });
}

function execCommand(command, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim();
      if (error) {
        error.output = output;
        reject(error);
        return;
      }
      resolve(output);
    });
  });
}

function execFileCommand(file, args, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim();
      if (error) {
        error.output = output;
        reject(error);
        return;
      }
      resolve(output);
    });
  });
}

async function applyDynamicPerformance(settings) {
  await execFileCommand("docker", [
    "exec",
    "hosting-redis",
    "redis-cli",
    "CONFIG",
    "SET",
    "maxmemory",
    `${settings.redis.maxMemoryMb}mb`,
  ]);
  await execFileCommand("docker", [
    "exec",
    "hosting-redis",
    "redis-cli",
    "CONFIG",
    "SET",
    "maxmemory-policy",
    settings.redis.policy,
  ]);

  const sql = [
    `SET PERSIST innodb_buffer_pool_size = ${settings.mysql.bufferPoolMb * 1024 * 1024}`,
    `SET PERSIST max_connections = ${settings.mysql.maxConnections}`,
    `SET PERSIST innodb_redo_log_capacity = ${settings.mysql.redoLogCapacityMb * 1024 * 1024}`,
  ].join("; ");
  await execFileCommand("docker", [
    "exec",
    "-e",
    `MYSQL_PERFORMANCE_SQL=${sql}`,
    "hosting-db",
    "sh",
    "-c",
    'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "$MYSQL_PERFORMANCE_SQL"',
  ], 60_000);
}

async function validateAndReload(mapBefore = null, poolsBefore = null) {
  try {
    const output = await execCommand(
      "docker exec hosting-nginx nginx -t && docker exec hosting-php-fpm php-fpm -t",
      20_000,
    );
    await execCommand("docker exec hosting-nginx nginx -s reload");
    await execCommand("docker exec hosting-php-fpm sh -c 'kill -USR2 1'");
    return output;
  } catch (error) {
    if (mapBefore !== null && poolsBefore !== null) {
      fs.writeFileSync(SITES_MAP_PATH, mapBefore, "utf8");
      fs.writeFileSync(POOLS_PATH, poolsBefore, "utf8");
    }
    throw error;
  }
}

function getSitesWithPools(mapParsed, poolsParsed) {
  const states = siteState.read().sites;
  const sites = Object.values(mapParsed.hosts).map((s) => {
    const pool = s.port ? poolsParsed.byPort[s.port] : null;
    return {
      ...s,
      poolName: pool ? pool.name : "",
      pool: pool ? pool.settings : null,
      poolTier: detectTier(pool ? pool.settings : null),
      state: { ...siteState.defaults(), ...(states[s.host] || {}) },
    };
  });
  return annotateSiteAliases(sites);
}

function currentSites() {
  const mapParsed = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
  const poolsParsed = parsePools(fs.readFileSync(POOLS_PATH, "utf8"));
  return { mapParsed, poolsParsed, sites: getSitesWithPools(mapParsed, poolsParsed) };
}

function siteDirectory(site) {
  const directory = String(site.root || "").replace(/^\/var\/www\//, "").replace(/\/$/, "");
  if (!directory || directory.includes("/") || directory.includes("\\")) {
    const error = new Error(`Unsupported document root for ${site.host}`);
    error.statusCode = 409;
    throw error;
  }
  return directory;
}

async function createSiteRemovalPlan(domain) {
  const runtime = currentSites();
  const site = runtime.sites.find((item) => item.host === domain && !item.isAlias);
  if (!site) {
    const error = new Error("Primary website is not configured");
    error.statusCode = 404;
    throw error;
  }
  const warnings = [];
  const directory = siteDirectory(site);
  let database = null;
  if (site.state?.siteType !== "static") {
    try {
      database = await wordpressDatabaseConfig(directory);
    } catch (error) {
      warnings.push(`Database inspection failed for ${site.host}: ${error.message}`);
    }
  }

  const databaseReferences = [];
  let databaseInspectionComplete = true;
  const otherSites = runtime.sites.filter((item) => !item.isAlias && item.host !== site.host);
  const referenceResults = [];
  for (let offset = 0; offset < otherSites.length; offset += 4) {
    const batch = await Promise.all(otherSites.slice(offset, offset + 4).map(async (otherSite) => {
      if (otherSite.state?.siteType === "static") return { domain: otherSite.host, static: true };
      try {
        return { domain: otherSite.host, ...(await wordpressDatabaseConfig(siteDirectory(otherSite))) };
      } catch (error) {
        return { domain: otherSite.host, error: error.message };
      }
    }));
    referenceResults.push(...batch);
  }
  for (const reference of referenceResults) {
    if (reference.static) {
      // Static/PHP sites intentionally have no database reference.
    } else if (reference.error) {
      databaseInspectionComplete = false;
      warnings.push(`Could not verify database ownership for ${reference.domain}`);
    } else {
      databaseReferences.push(reference);
    }
  }
  if (database) databaseReferences.push({ domain: site.host, ...database });

  let npmHosts = [];
  let certificates = [];
  if (npm.configured()) {
    try {
      [npmHosts, certificates] = await Promise.all([npm.listHosts(), npm.listCertificates()]);
    } catch (error) {
      warnings.push(`NPM inspection failed: ${error.message}`);
    }
  }

  let dnsRecords = [];
  const targetDomains = new Set([site.host, ...(site.aliases || [])]);
  if (cloudflare.configured()) {
    try {
      const result = await cloudflare.records(site.host);
      dnsRecords = result.records.filter((record) =>
        targetDomains.has(record.name) && ["A", "AAAA", "CNAME"].includes(record.type));
    } catch (error) {
      warnings.push(`Cloudflare inspection failed: ${error.message}`);
    }
  }

  let backups = [];
  try {
    backups = backupManager.history(site.host);
  } catch (error) {
    warnings.push(`Backup inspection failed: ${error.message}`);
  }

  return buildSiteRemovalPlan({
    site,
    allSites: runtime.sites,
    database,
    databaseReferences,
    databaseInspectionComplete,
    npmHosts,
    certificates,
    dnsRecords,
    backups,
    warnings,
  });
}

async function executeSiteRemoval(domain, selected, jobContext = null) {
  validateSiteRemovalSelection(selected);
  const operationStatus = backupManager.status();
  if (operationStatus.busy) {
    const error = new Error(`Cannot delete while another storage operation is running: ${operationStatus.currentJob?.label || "busy"}`);
    error.statusCode = 409;
    throw error;
  }

  const plan = await createSiteRemovalPlan(domain);
  if (selected.npmCertificate && plan.resources.npmHost.available && !selected.npmHost) {
    const error = new Error("Remove the NPM proxy host before removing its certificate");
    error.statusCode = 400;
    throw error;
  }
  for (const [resource, enabled] of Object.entries(selected)) {
    if (!enabled) continue;
    const assessment = plan.resources[resource];
    if (!assessment?.available) {
      const error = new Error(`${resource} is not available for ${domain}`);
      error.statusCode = 409;
      throw error;
    }
    if (!assessment.safe) {
      const shared = assessment.sharedBy?.length ? ` Shared by: ${assessment.sharedBy.join(", ")}.` : "";
      const error = new Error(`${resource} is not safe to remove.${shared}`);
      error.statusCode = 409;
      throw error;
    }
  }

  return backupManager.withLock({ type: "site-removal", domain, label: `Delete ${domain}` }, async () => {
    const runtime = currentSites();
    const site = runtime.sites.find((item) => item.host === domain && !item.isAlias);
    const steps = [];
    const record = (step) => {
      steps.push(step);
      jobContext?.update({
        completed: steps.length,
        results: steps.map((item) => ({ ...item, ok: true })),
      });
    };
    if (selected.finalBackup) {
      jobContext?.checkpoint("Cancelled before the final safety backup");
      jobContext?.update({ currentStep: `Creating final backup for ${domain}` });
      const backup = await backupManager.createSiteBackup(site, backupManager.readSettings().retention + 1);
      record({ name: "final-backup", status: "complete", id: backup.id });
    }
    jobContext?.checkpoint("Cancelled before destructive removal began");
    if (selected.cloudflareDns) {
      jobContext?.update({ currentStep: `Removing Cloudflare DNS for ${domain}` });
      for (const recordId of plan.resources.cloudflareDns.ids) await cloudflare.deleteRecord(domain, recordId);
      record({ name: "cloudflare-dns", status: "complete", count: plan.resources.cloudflareDns.count });
    }
    if (selected.npmHost) {
      jobContext?.update({ currentStep: `Removing proxy host for ${domain}` });
      for (const hostId of plan.resources.npmHost.ids) await npm.deleteHost(hostId);
      record({ name: "npm-host", status: "complete", count: plan.resources.npmHost.count });
    }
    if (selected.npmCertificate) {
      jobContext?.update({ currentStep: `Removing certificate for ${domain}` });
      for (const certificateId of plan.resources.npmCertificate.ids) await npm.deleteCertificate(certificateId);
      record({ name: "npm-certificate", status: "complete", count: plan.resources.npmCertificate.count });
    }
    if (selected.runtime) {
      jobContext?.update({ currentStep: `Removing runtime configuration for ${domain}` });
      const mapBefore = fs.readFileSync(SITES_MAP_PATH, "utf8");
      const poolsBefore = fs.readFileSync(POOLS_PATH, "utf8");
      const mapParsed = parseSitesMap(mapBefore);
      const poolsParsed = parsePools(poolsBefore);
      for (const host of plan.targetDomains) delete mapParsed.hosts[host];
      for (const host of Object.keys(mapParsed.hosts)) {
        if (plan.targetDomains.includes(mapParsed.hosts[host].canonicalTo)) mapParsed.hosts[host].canonicalTo = "";
      }
      if (selected.pool && plan.pool.name) {
        delete poolsParsed.sections[plan.pool.name];
        poolsParsed.sectionOrder = poolsParsed.sectionOrder.filter((name) => name !== plan.pool.name);
      }
      writeConfigs({ mapBefore, poolsBefore, mapParsed, poolsParsed });
      await validateAndReload(mapBefore, poolsBefore);
      record({ name: "runtime", status: "complete", count: plan.targetDomains.length });
      if (selected.pool) record({ name: "pool", status: "complete", count: 1 });
    }
    if (selected.panelState) {
      jobContext?.update({ currentStep: `Removing panel state for ${domain}` });
      siteState.remove(plan.targetDomains);
      record({ name: "panel-state", status: "complete" });
    }
    if (selected.database) {
      jobContext?.update({ currentStep: `Removing database for ${domain}` });
      await dropDatabaseAndUser(plan.database.name, plan.database.user, integrationSettings.resolved());
      record({ name: "database", status: "complete", database: plan.database.name });
    }
    if (selected.files) {
      jobContext?.update({ currentStep: `Removing website files for ${domain}` });
      removeSiteDirectory(WEBSITES_ROOT, plan.directory);
      record({ name: "files", status: "complete", directory: plan.directory });
    }
    if (selected.backups) {
      jobContext?.update({ currentStep: `Removing stored backups for ${domain}` });
      backupManager.deleteSiteBackups(domain);
      record({ name: "backups", status: "complete" });
    }
    return {
      ok: true,
      domain,
      steps,
      results: steps.map((step) => ({ ...step, ok: true })),
      total: Object.values(selected).filter(Boolean).length,
      completed: steps.length,
      message: `Selected resources for ${domain} were deleted`,
    };
  });
}

jobManager.register("site.remove", (context, payload) =>
  executeSiteRemoval(validateDomain(payload.domain), validateSiteRemovalSelection(payload.selected), context));

async function provisionImportedWebsite({ body, domain, directory, dnsIp, presetRecords, jobContext }) {
  const uploadId = String(body.import_upload_id || "");
  const settings = integrationSettings.resolved();
  const databaseName = mysqlIdentifier(domain, settings.mysqlSitePrefix || process.env.MYSQL_SITE_PREFIX || "yogali00_");
  const alias = body.add_www && !domain.startsWith("www.") ? `www.${domain}` : "";
  const aliases = alias ? [alias] : [];

  return backupManager.withLock({ type: "site-import", domain, label: `Import ${domain}` }, async () => {
    jobContext?.checkpoint("Provisioning cancelled before archive preparation");
    jobContext?.update({ completed: 1, currentStep: "Validating and preparing uploaded archives" });
    const prepared = await provisionImports.prepare(uploadId, directory);
    jobContext?.checkpoint("Provisioning cancelled before website and database import");
    jobContext?.update({ completed: 2, currentStep: "Importing website files and database" });
    const manifest = {
      version: 1,
      type: "hosting-sites-export",
      id: `ui-${uploadId}`,
      createdAt: new Date().toISOString(),
      sites: [{
        domain,
        aliases,
        canonicalAliases: aliases,
        websitePath: directory,
        database: databaseName,
        websiteArchive: prepared.websiteArchive,
        databaseDump: prepared.databaseDump,
        poolTier: String(body.pool_tier || "medium"),
        state: {
          fastcgiCache: Boolean(body.fastcgi_cache),
          redis: Boolean(body.redis),
          opcache: body.opcache !== false,
          backupEnabled: Boolean(body.scheduled_backup),
          imageOptimizationEnabled: Boolean(body.scheduled_image_optimization),
          siteType: "wordpress",
        },
      }],
    };
    const imported = await migrationManager.importSites({
      sourceDirectory: prepared.sourceDirectory,
      manifest,
      useExistingFiles: false,
      wanIp: dnsIp,
      updateDns: Boolean(body.create_update_dns),
      proxied: true,
      createNpmHost: Boolean(body.create_npm_host),
      issueSsl: Boolean(body.issue_ssl),
      includeCredentials: true,
    });
    jobContext?.update({ completed: 6, currentStep: "Applying optional website integrations" });
    const result = imported.results[0];
    const steps = [
      { name: "website-import", status: "complete" },
      { name: "database", status: "complete", database: result.database },
      { name: "runtime", status: "complete", port: result.port },
    ];
    for (const warning of result.warnings || []) steps.push({ name: "integration", status: "warning", message: warning });
    if (body.redis) {
      try {
        await setRedis(directory, domain, true);
        steps.push({ name: "redis", status: "complete" });
      } catch (error) {
        steps.push({ name: "redis", status: "warning", message: error.message });
      }
    }
    if (presetRecords.length) {
      try {
        for (const record of presetRecords) await cloudflare.upsertRecord(domain, record);
        steps.push({ name: "dns-preset", status: "complete", count: presetRecords.length });
      } catch (error) {
        steps.push({ name: "dns-preset", status: "warning", message: error.message });
      }
    }
    const securityStep = await provisionSecurityStep(
      cloudflareSecurity,
      domain,
      selectedProvisionSecurity(body, "wordpress"),
    );
    if (securityStep) steps.push(securityStep);
    siteState.update(domain, {
      imageOptimizationEnabled: Boolean(body.scheduled_image_optimization),
      siteType: "wordpress",
      notes: String(body.notes || "").slice(0, 2000),
    });
    provisionImports.remove(uploadId);
    jobContext?.update({ completed: 8, currentStep: "Finalizing imported website" });
    return {
      ok: true,
      imported: true,
      siteType: "wordpress",
      domain,
      directory,
      port: result.port,
      database: { name: result.database, user: result.database, password: result.databasePassword },
      wordpress: { preserved: true },
      steps,
    };
  });
}

function validateProvisionRequest(body) {
  const domain = validateDomain(body.domain);
  const directory = safeRelative(String(body.directory || domain).trim(), "website directory");
  const sourceMode = body.source_mode === "import" ? "import" : "fresh";
  const siteType = body.site_type === "static" ? "static" : "wordpress";
  const adminEmail = String(body.admin_email || "").trim().toLowerCase();
  const adminUser = String(body.admin_user || "admin").trim();
  if (siteType === "wordpress" && sourceMode === "fresh" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
    throw Object.assign(new Error("Enter a valid WordPress administrator email"), { statusCode: 400 });
  }
  if (siteType === "wordpress" && sourceMode === "fresh" && !/^[a-zA-Z0-9_.@-]{3,60}$/.test(adminUser)) {
    throw Object.assign(new Error("WordPress administrator username is invalid"), { statusCode: 400 });
  }
  if (sourceMode === "import" && !body.import_upload_id) {
    throw Object.assign(new Error("Upload the website files before starting the import"), { statusCode: 400 });
  }
  return { domain, directory, sourceMode, siteType, adminEmail, adminUser };
}

async function executeProvisioning(body, jobContext, adminPassword = "") {
  const { domain, directory, sourceMode, siteType, adminEmail, adminUser } = validateProvisionRequest(body);
  const pluginPackages = siteType === "wordpress" && sourceMode === "fresh" ? wordpressPackages.resolve("plugins", body.plugin_packages) : [];
  const themePackages = siteType === "wordpress" && sourceMode === "fresh" ? wordpressPackages.resolve("themes", body.theme_packages) : [];
  const dnsIp = body.create_update_dns ? validateIpv4(body.dns_ip) : "";
  const presetRecords = body.apply_dns_preset
    ? dnsPresets.resolveAll(String(body.dns_preset_id || ""), domain)
    : [];
  const securityPreset = selectedProvisionSecurity(body, siteType);
  const mapBefore = fs.readFileSync(SITES_MAP_PATH, "utf8");
  const poolsBefore = fs.readFileSync(POOLS_PATH, "utf8");
  const mapParsed = parseSitesMap(mapBefore);
  const poolsParsed = parsePools(poolsBefore);
  if (mapParsed.hosts[domain]) {
    throw Object.assign(new Error("Domain is already configured"), { statusCode: 409 });
  }

  if (siteType === "wordpress" && sourceMode === "import") {
    return provisionImportedWebsite({ body, domain, directory, dnsIp, presetRecords, jobContext });
  }

  jobContext?.checkpoint("Provisioning cancelled before website files were prepared");
  jobContext?.update({ completed: 1, currentStep: sourceMode === "import" ? "Extracting website archive" : "Preparing website files" });
  const sitePath = prepareSiteDirectory(WEBSITES_ROOT, directory);
  if (siteType === "static") {
    if (sourceMode === "import") {
      await provisionImports.installWebsiteArchive(String(body.import_upload_id || ""), sitePath);
    } else {
      fs.writeFileSync(
        path.join(sitePath, "index.html"),
        `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${domain}</title></head><body><main><h1>${domain}</h1></main></body></html>\n`,
        { encoding: "utf8", mode: 0o664 },
      );
    }
    await normalizeWordPressPermissions(directory);
  }

  jobContext?.checkpoint("Provisioning cancelled before runtime configuration was changed");
  jobContext?.update({ completed: 2, currentStep: "Creating PHP and nginx runtime configuration" });
  const usedPorts = Object.values(poolsParsed.sections).map((pool) => Number(pool.listen)).filter(Number.isInteger);
  const port = Math.max(9000, ...usedPorts) + 1;
  const poolName = sanitizeSectionName(domain);
  const defaults = readDefaultPool();
  const presets = readPoolPresets();
  const tier = normalizeTier(body.pool_tier, presets) || normalizeTier(defaults.default_tier, presets) || "medium";
  const root = `/var/www/${directory}`;
  poolsParsed.sections[poolName] = buildPoolSettings({
    incomingPool: {}, basePool: {}, defaults, tierName: tier, root, port, presets,
  });
  setPoolOpcache(poolsParsed.sections[poolName], body.opcache !== false);
  poolsParsed.sectionOrder.push(poolName);
  mapParsed.hosts[domain] = { host: domain, root, port, upstream: `hosting-php-fpm:${port}`, canonicalTo: "" };
  const domains = [domain];
  if (body.add_www && !domain.startsWith("www.")) {
    const alias = `www.${domain}`;
    domains.push(alias);
    mapParsed.hosts[alias] = { host: alias, root, port, upstream: `hosting-php-fpm:${port}`, canonicalTo: domain };
  }

  writeConfigs({ mapBefore, poolsBefore, mapParsed, poolsParsed });
  const steps = [];
  await validateAndReload(mapBefore, poolsBefore);
  steps.push({ name: "runtime", status: "complete" });
  jobContext?.update({ completed: 3, currentStep: siteType === "wordpress" ? "Creating database and installing WordPress" : "Registering website state" });
  let database = null;
  if (siteType === "wordpress") {
    database = await createDatabase(domain, integrationSettings.resolved());
    steps.push({ name: "database", status: "complete", database: database.name });
    await installWordPress({
      domain, directory, database, title: String(body.title || domain), adminEmail, adminUser,
      adminPassword, redis: Boolean(body.redis), useHttps: false,
      commentsEnabled: Boolean(body.enable_comments), keepDefaultPlugins: Boolean(body.keep_default_plugins),
      keepDefaultThemes: Boolean(body.keep_default_themes), pluginPackages, themePackages,
    });
    steps.push({ name: "wordpress", status: "complete" });
  } else {
    steps.push({ name: sourceMode === "import" ? "website-import" : "website-files", status: "complete" });
  }

  siteState.update(domain, {
    fastcgiCache: Boolean(body.fastcgi_cache), redis: siteType === "wordpress" && Boolean(body.redis),
    opcache: body.opcache !== false, backupEnabled: Boolean(body.scheduled_backup),
    imageOptimizationEnabled: Boolean(body.scheduled_image_optimization), siteType, cacheVersion: 1,
    notes: String(body.notes || "").slice(0, 2000),
  });
  await execCommand("docker exec hosting-nginx nginx -s reload");
  jobContext?.update({ completed: 5, currentStep: "Applying DNS and proxy integrations" });

  if (body.create_update_dns) {
    try {
      for (const host of domains) await cloudflare.upsertHostAddress(host, dnsIp, true);
      steps.push({ name: "dns", status: "complete", count: domains.length });
    } catch (error) {
      steps.push({ name: "dns", status: "warning", message: error.message });
    }
  }
  if (presetRecords.length) {
    try {
      for (const record of presetRecords) await cloudflare.upsertRecord(domain, record);
      steps.push({ name: "dns-preset", status: "complete", count: presetRecords.length });
    } catch (error) {
      steps.push({ name: "dns-preset", status: "warning", message: error.message });
    }
  }
  let npmHost = null;
  if (body.create_npm_host) {
    try {
      npmHost = await npm.ensureHost(domains, Boolean(body.issue_ssl));
      steps.push({ name: "npm", status: "complete", hostId: npmHost.id });
      if (npmHost.certificate_id) {
        if (siteType === "wordpress") await updateWordPressUrl(directory, domain, true);
        steps.push({ name: "https", status: "complete" });
      }
    } catch (error) {
      steps.push({ name: "npm", status: "warning", message: error.message });
    }
  }
  const securityStep = await provisionSecurityStep(cloudflareSecurity, domain, securityPreset);
  if (securityStep) steps.push(securityStep);
  if (siteType === "static" && sourceMode === "import") provisionImports.remove(String(body.import_upload_id || ""));
  jobContext?.update({ completed: 8, currentStep: "Finalizing website" });
  return {
    ok: true, imported: sourceMode === "import", siteType, domain, directory, port,
    database: database ? { name: database.name, user: database.user, password: database.password } : null,
    wordpress: siteType === "wordpress" ? { adminUser, adminPassword, adminEmail } : null,
    npmHost, steps,
  };
}

jobManager.register("site.provision", async (context, payload) => {
  const body = safeProvisionPayload(payload.request || {});
  const secret = payload.requestRef ? provisioningVault.take(payload.requestRef, payload.owner) : null;
  if (payload.requestRef && !secret) throw new Error("Provisioning request credentials expired; submit the form again");
  const result = await executeProvisioning(body, context, secret?.adminPassword || "");
  if (result.database) {
    provisioningVault.put(context.id, payload.owner, {
      domain: result.domain,
      imported: result.imported,
      database: result.database,
      wordpress: result.wordpress,
    });
  }
  return provisioningJobResult(result);
});

function writeConfigs({ mapBefore, poolsBefore, mapParsed, poolsParsed }) {
  backupFile(SITES_MAP_PATH, mapBefore);
  backupFile(POOLS_PATH, poolsBefore);
  fs.writeFileSync(SITES_MAP_PATH, renderSitesMap(mapParsed), "utf8");
  fs.writeFileSync(POOLS_PATH, renderPools(poolsParsed), "utf8");
}

async function handleApi(req, res) {
  const requestUrl = new URL(req.url, "http://ui-manager.local");

  if (req.method === "GET" && requestUrl.pathname === "/api/jobs") {
    sendJson(res, 200, {
      ok: true,
      jobs: jobManager.list({
        status: requestUrl.searchParams.get("status"),
        type: requestUrl.searchParams.get("type"),
        limit: requestUrl.searchParams.get("limit"),
      }).map((job) => decorateJob(job, req.auth.email)),
    });
    return true;
  }

  if (requestUrl.pathname.startsWith("/api/jobs/")) {
    const parts = requestUrl.pathname.slice("/api/jobs/".length).split("/").filter(Boolean);
    const id = parts[0] || "";
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      sendJson(res, 400, { ok: false, message: "Invalid job identifier" });
      return true;
    }
    if (req.method === "GET" && parts.length === 1) {
      const job = jobManager.publicJob(jobManager.get(id));
      if (!job) sendJson(res, 404, { ok: false, message: "Job not found" });
      else sendJson(res, 200, { ok: true, job: decorateJob(job, req.auth.email) });
      return true;
    }
    if (req.method === "POST" && parts.length === 2 && parts[1] === "cancel") {
      sendJson(res, 200, { ok: true, job: jobManager.cancel(id) });
      return true;
    }
    if (req.method === "POST" && parts.length === 2 && parts[1] === "retry") {
      sendJson(res, 202, { ok: true, job: jobManager.retry(id, req.auth.email) });
      return true;
    }
  }

  if (req.method === "GET" && req.url === "/api/status") {
    sendJson(res, 200, {
      sitesMapPath: SITES_MAP_PATH,
      poolsPath: POOLS_PATH,
      sitesMapExists: fs.existsSync(SITES_MAP_PATH),
      poolsExists: fs.existsSync(POOLS_PATH),
      actionConfigured: {
        reload_nginx: Boolean(ACTION_CMDS.reload_nginx),
        reload_php: Boolean(ACTION_CMDS.reload_php),
        clear_opcache: Boolean(ACTION_CMDS.clear_opcache),
      },
      integrations: {
        npm: npm.configured(),
        cloudflare: cloudflare.configured(),
        cloudflareSecurity: cloudflareSecurity.configured(),
        ipinfo: ipinfo.configured(),
        mysql: true,
      },
    });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/stats/runtime") {
    sendJson(res, 200, {
      ok: true,
      ...(await statsCollector.runtime(requestUrl.searchParams.get("refresh") === "1")),
    });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/site-removal") {
    const domain = validateDomain(requestUrl.searchParams.get("domain"));
    sendJson(res, 200, { ok: true, plan: await createSiteRemovalPlan(domain) });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/site-removal") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const selected = parseSiteRemovalSelection(domain, body);
    sendJson(res, 202, { ok: true, job: jobManager.create(siteRemovalJobInput(domain, selected, req.auth.email)) });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/stats/site") {
    const domain = validateDomain(requestUrl.searchParams.get("domain"));
    sendJson(res, 200, { ok: true, ...(await collectSiteStats(domain, requestUrl.searchParams.get("refresh") === "1")) });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/stats/ipinfo/lookup") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const ip = String(body.ip || "").trim();
    const stats = await collectSiteStats(domain);
    if (!(stats.traffic?.topIps || []).some((row) => row.ip === ip)) {
      sendJson(res, 409, { ok: false, message: "Refresh website traffic and select an address from the current sample" });
      return true;
    }
    sendJson(res, 200, { ok: true, result: await ipinfo.lookup(ip, ipAddresses.read()) });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/transfers/export/preview") {
    const domains = requestUrl.searchParams.getAll("domain").map(validateDomain);
    sendJson(res, 200, {
      ok: true,
      destination: "/srv/exports/export-YYYY-MM-DD_HH-MM-SS",
      sites: await migrationManager.previewExport(domains),
    });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/transfers/export") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (!Array.isArray(body.domains) || !body.domains.length) {
      sendJson(res, 400, { ok: false, message: "Select at least one primary website" });
      return true;
    }
    const domains = [...new Set(body.domains.map(validateDomain))];
    const sites = migrationManager.selectedSites(domains);
    sendJson(res, 202, {
      ok: true,
      job: jobManager.create({
        type: "sites.export",
        label: `Export ${sites.length} website${sites.length === 1 ? "" : "s"}`,
        operator: req.auth.email,
        trigger: "manual",
        payload: { domains: sites.map((site) => site.host) },
        targets: sites.map((site) => site.host),
        conflicts: ["server-heavy", "storage:exports", ...sites.map((site) => `site:${site.host}`)],
        total: sites.length,
        cancellable: true,
        retryable: true,
      }),
    });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/transfers/exports") {
    sendJson(res, 200, { ok: true, exports: migrationManager.listExports() });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname.startsWith("/api/transfers/exports/")) {
    const exportId = decodeURIComponent(requestUrl.pathname.slice("/api/transfers/exports/".length));
    const artifact = migrationManager.exportFile(
      exportId,
      requestUrl.searchParams.get("file"),
      EXPORT_DOWNLOAD_MAX_BYTES,
    );
    const downloadName = artifact.name.replace(/[^A-Za-z0-9._-]/g, "_");
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": artifact.size,
      "Content-Disposition": `attachment; filename="${downloadName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(artifact.path).pipe(res);
    return true;
  }

  if (req.method === "DELETE" && requestUrl.pathname === "/api/stats/ipinfo/cache") {
    ipinfo.clear();
    sendJson(res, 200, { ok: true, message: "IPinfo cache cleared" });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/backups/settings") {
    sendJson(res, 200, {
      settings: backupManager.readSettings(),
      status: backupManager.status(),
    });
    return true;
  }

  if (req.method === "PUT" && requestUrl.pathname === "/api/backups/settings") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const settings = backupManager.updateSettings({
      scheduleTime: body.schedule_time,
      retention: body.retention,
      siteBackupsEnabled: body.site_backups_enabled,
      appDataEnabled: body.app_data_enabled,
    });
    sendJson(res, 200, { ok: true, settings });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/backups") {
    const name = requestUrl.searchParams.get("name") || "app-data";
    const safeName = name === "app-data" ? name : validateDomain(name);
    sendJson(res, 200, { name: safeName, backups: backupManager.history(safeName) });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/backups/site") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const mapParsed = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
    const poolsParsed = parsePools(fs.readFileSync(POOLS_PATH, "utf8"));
    const site = getSitesWithPools(mapParsed, poolsParsed)
      .find((item) => item.host === domain && !item.isWwwAlias);
    if (!site) {
      sendJson(res, 404, { ok: false, message: "Site is not configured" });
      return true;
    }
    sendJson(res, 202, { ok: true, job: backupManager.enqueueSite(site, req.auth.email) });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/backups/sites") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const scope = String(body.scope || "enabled");
    if (!new Set(["enabled", "all"]).has(scope)) {
      sendJson(res, 400, { ok: false, message: "Backup scope must be enabled or all" });
      return true;
    }
    backupManager.ensureSiteBackupsEnabled();
    sendJson(res, 202, { ok: true, job: backupManager.enqueueSites(scope, req.auth.email) });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/backups/app-data") {
    sendJson(res, 202, { ok: true, job: backupManager.enqueueAppData(req.auth.email) });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/backups/restore") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const mapParsed = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
    const poolsParsed = parsePools(fs.readFileSync(POOLS_PATH, "utf8"));
    const site = getSitesWithPools(mapParsed, poolsParsed)
      .find((item) => item.host === domain && !item.isWwwAlias);
    if (!site) {
      sendJson(res, 404, { ok: false, message: "Site is not configured" });
      return true;
    }
    const backupIdValue = String(body.backup_id || "");
    backupManager.readSiteManifest(site, backupIdValue);
    sendJson(res, 202, { ok: true, job: backupManager.enqueueRestore(site, backupIdValue, req.auth.email) });
    return true;
  }

  if (req.method === "DELETE" && requestUrl.pathname.startsWith("/api/backups/")) {
    const parts = requestUrl.pathname.slice("/api/backups/".length).split("/").map(decodeURIComponent);
    if (parts.length !== 2) {
      sendJson(res, 400, { ok: false, message: "Backup name and identifier are required" });
      return true;
    }
    const name = parts[0] === "app-data" ? parts[0] : validateDomain(parts[0]);
    backupManager.deleteBackup(name, parts[1]);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/settings/integrations") {
    sendJson(res, 200, integrationSettings.publicView());
    return true;
  }

  if (req.method === "PUT" && requestUrl.pathname === "/api/settings/integrations") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const updated = integrationSettings.update(body);
    npm.cachedToken = null;
    sendJson(res, 200, { ok: true, settings: updated });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/settings/notifications") {
    sendJson(res, 200, { ok: true, settings: notificationSettings.publicView() });
    return true;
  }

  if (req.method === "PUT" && requestUrl.pathname === "/api/settings/notifications") {
    const body = JSON.parse((await readBody(req)) || "{}");
    sendJson(res, 200, { ok: true, settings: notificationSettings.update(body) });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/settings/notifications/test") {
    const body = JSON.parse((await readBody(req)) || "{}");
    try {
      sendJson(res, 200, await notificationManager.test(String(body.channel || "")));
    } catch (error) {
      error.statusCode ||= 502;
      throw error;
    }
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, health: healthMonitor.publicState() });
    return true;
  }

  if (req.method === "PUT" && requestUrl.pathname === "/api/health/settings") {
    const body = JSON.parse((await readBody(req)) || "{}");
    healthSettings.save(body);
    sendJson(res, 200, { ok: true, health: healthMonitor.publicState() });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/health/run") {
    sendJson(res, 200, { ok: true, health: await healthMonitor.run() });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/settings/performance") {
    sendJson(res, 200, { settings: performanceSettings.read() });
    return true;
  }

  if (req.method === "PUT" && requestUrl.pathname === "/api/settings/performance") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const previousSettings = performanceSettings.read();
    const snapshot = performanceSettings.snapshot();
    try {
      const settings = performanceSettings.save(body);
      performanceSettings.applyFiles(settings);
      await validateAndReload();
      await applyDynamicPerformance(settings);
      sendJson(res, 200, {
        ok: true,
        settings,
        message: "Performance settings applied to PHP, nginx, Redis, and MySQL.",
      });
    } catch (error) {
      performanceSettings.restore(snapshot);
      try {
        await validateAndReload();
      } catch (rollbackError) {
        console.error(`Could not reload restored PHP/nginx settings: ${rollbackError.message}`);
      }
      try {
        await applyDynamicPerformance(previousSettings);
      } catch (rollbackError) {
        console.error(`Could not restore Redis/MySQL settings: ${rollbackError.message}`);
      }
      throw error;
    }
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/settings/test") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (body.target === "npm") {
      const hosts = await npm.listHosts();
      sendJson(res, 200, { ok: true, message: `Connected to NPM. ${hosts.length} proxy hosts found.` });
      return true;
    }
    if (body.target === "cloudflare") {
      const token = await cloudflare.verify();
      sendJson(res, 200, { ok: true, message: `Cloudflare token status: ${token.status || "active"}.` });
      return true;
    }
    if (body.target === "cloudflare-security") {
      const token = await cloudflareSecurity.verify();
      sendJson(res, 200, { ok: true, message: `Cloudflare Security token status: ${token.status || "active"}.` });
      return true;
    }
    if (body.target === "ipinfo") {
      const result = await ipinfo.lookup("8.8.8.8", [], { force: true });
      sendJson(res, 200, { ok: true, message: `Connected to IPinfo${result.country ? ` (${result.country})` : ""}.` });
      return true;
    }
    if (body.target === "mysql") {
      const settings = integrationSettings.resolved();
      const output = await execCommand(
        `docker exec ${settings.mysqlContainer} sh -c 'mysqladmin -uroot -p"$MYSQL_ROOT_PASSWORD" ping'`,
        15_000,
      );
      sendJson(res, 200, { ok: true, message: output || "MySQL is available." });
      return true;
    }
    sendJson(res, 400, { ok: false, message: "Unknown integration target" });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/npm/hosts") {
    sendJson(res, 200, { hosts: await npm.listHosts() });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/npm/certificates") {
    sendJson(res, 200, { certificates: await npm.listCertificates() });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/npm/hosts/ensure") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const domains = [domain];
    if (body.add_www && !domain.startsWith("www.")) domains.push(`www.${domain}`);
    if (body.issue_ssl) {
      const job = certificateJobManager.enqueueIssue(domains, req.auth.email);
      sendJson(res, 202, { ok: true, job });
      return true;
    }
    const host = await npm.ensureHost(domains, false);
    sendJson(res, 200, { ok: true, host });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/npm/certificates/renew") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const job = certificateJobManager.enqueueRenew(domain, body.certificate_id, req.auth.email);
    sendJson(res, 202, { ok: true, job });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/cloudflare/records") {
    const domain = validateDomain(requestUrl.searchParams.get("domain"));
    sendJson(res, 200, await cloudflare.records(domain));
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/cloudflare/security") {
    const domain = validateDomain(requestUrl.searchParams.get("domain"));
    sendJson(res, 200, await cloudflareSecurity.securityRules(domain));
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/cloudflare/security/presets") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const preset = String(body.preset || "");
    if (!["suspicious-probes", "xmlrpc-challenge", "login-rate-limit"].includes(preset)) {
      sendJson(res, 400, { ok: false, message: "Unknown Cloudflare security preset" });
      return true;
    }
    sendJson(res, 201, { ok: true, ...(await cloudflareSecurity.applySecurityPreset(domain, preset)) });
    return true;
  }

  if (["PATCH", "DELETE"].includes(req.method)
      && /^\/api\/cloudflare\/security\/rules\/[^/]+\/[^/]+$/.test(requestUrl.pathname)) {
    const parts = requestUrl.pathname.split("/").map(decodeURIComponent);
    const rulesetId = parts[5];
    const ruleId = parts[6];
    if (!/^[a-zA-Z0-9_-]+$/.test(rulesetId) || !/^[a-zA-Z0-9_-]+$/.test(ruleId)) {
      sendJson(res, 400, { ok: false, message: "Cloudflare rule identifier is invalid" });
      return true;
    }
    if (req.method === "PATCH") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const domain = validateDomain(body.domain);
      const rule = await cloudflareSecurity.updateSecurityRule(domain, rulesetId, ruleId, body.enabled);
      sendJson(res, 200, { ok: true, rule });
    } else {
      const domain = validateDomain(requestUrl.searchParams.get("domain"));
      await cloudflareSecurity.deleteSecurityRule(domain, rulesetId, ruleId);
      sendJson(res, 200, { ok: true });
    }
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/cloudflare/records") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const result = await cloudflare.createRecord(domain, body);
    sendJson(res, 201, { ok: true, record: result.result });
    return true;
  }

  if (req.method === "PUT" && requestUrl.pathname.startsWith("/api/cloudflare/records/")) {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const recordId = decodeURIComponent(requestUrl.pathname.replace("/api/cloudflare/records/", ""));
    const result = await cloudflare.updateRecord(domain, recordId, body);
    sendJson(res, 200, { ok: true, record: result.result });
    return true;
  }

  if (req.method === "DELETE" && requestUrl.pathname.startsWith("/api/cloudflare/records/")) {
    const domain = validateDomain(requestUrl.searchParams.get("domain"));
    const recordId = decodeURIComponent(requestUrl.pathname.replace("/api/cloudflare/records/", ""));
    await cloudflare.deleteRecord(domain, recordId);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/dns-presets") {
    sendJson(res, 200, { presets: dnsPresets.read() });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/dns-presets") {
    const body = JSON.parse((await readBody(req)) || "{}");
    sendJson(res, body.id ? 200 : 201, { ok: true, preset: dnsPresets.save(body) });
    return true;
  }

  if (req.method === "DELETE" && requestUrl.pathname.startsWith("/api/dns-presets/")) {
    const presetId = decodeURIComponent(requestUrl.pathname.replace("/api/dns-presets/", ""));
    dnsPresets.delete(presetId);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && /^\/api\/dns-presets\/[^/]+\/apply$/.test(requestUrl.pathname)) {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const presetId = decodeURIComponent(requestUrl.pathname.split("/")[3]);
    const records = dnsPresets.resolveAll(presetId, domain);
    const results = [];
    for (const record of records) results.push((await cloudflare.upsertRecord(domain, record)).result);
    sendJson(res, 200, { ok: true, records: results, count: results.length });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/wordpress-packages") {
    sendJson(res, 200, wordpressPackages.publicView());
    return true;
  }

  if (req.method === "POST" && /^\/api\/wordpress-packages\/(plugins|themes)$/.test(requestUrl.pathname)) {
    const kind = requestUrl.pathname.split("/").pop();
    const filename = requestUrl.searchParams.get("filename") || "";
    const content = await readBinaryBody(req);
    sendJson(res, 201, { ok: true, package: wordpressPackages.upload(kind, filename, content) });
    return true;
  }

  if (req.method === "DELETE" && /^\/api\/wordpress-packages\/(plugins|themes)\/[^/]+$/.test(requestUrl.pathname)) {
    const parts = requestUrl.pathname.split("/");
    wordpressPackages.delete(parts[3], decodeURIComponent(parts[4]));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/cloudflare/ip-addresses") {
    sendJson(res, 200, { addresses: ipAddresses.read() });
    return true;
  }

  if (req.method === "PUT" && requestUrl.pathname === "/api/cloudflare/ip-addresses") {
    const body = JSON.parse((await readBody(req)) || "{}");
    sendJson(res, 200, { ok: true, addresses: ipAddresses.save(body.addresses) });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/cloudflare/replace-a-records") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const fromIp = validateIpv4(body.from_ip);
    const toIp = validateIpv4(body.to_ip);
    if (fromIp === toIp) {
      sendJson(res, 400, { ok: false, message: "Old and replacement IP addresses must be different" });
      return true;
    }
    sendJson(res, 200, { ok: true, ...(await cloudflare.replaceARecords(fromIp, toIp)) });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/site-state") {
    const domain = validateDomain(requestUrl.searchParams.get("domain"));
    sendJson(res, 200, { domain, state: siteState.get(domain) });
    return true;
  }

  if (req.method === "PUT" && requestUrl.pathname === "/api/site-state") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const mapContent = fs.readFileSync(SITES_MAP_PATH, "utf8");
    const mapParsed = parseSitesMap(mapContent);
    const site = mapParsed.hosts[domain];
    if (!site) {
      sendJson(res, 404, { ok: false, message: "Site is not configured" });
      return true;
    }
    const currentState = siteState.get(domain);
    if (body.redis === true && !supportsWordPressRedis(currentState.siteType)) {
      sendJson(res, 400, { ok: false, message: "Redis object cache is available only for WordPress websites" });
      return true;
    }
    if (typeof body.redis === "boolean" && body.redis !== Boolean(currentState.redis)) {
      const directory = String(site.root || "").replace(/^\/var\/www\//, "").replace(/\/$/, "");
      await setRedis(directory, domain, body.redis);
    }
    let opcacheChanged = false;
    let mapBefore = null;
    let poolsBefore = null;
    if (typeof body.opcache === "boolean" && body.opcache !== Boolean(currentState.opcache)) {
      mapBefore = mapContent;
      poolsBefore = fs.readFileSync(POOLS_PATH, "utf8");
      const poolsParsed = parsePools(poolsBefore);
      const pool = poolsParsed.byPort[site.port];
      if (!pool) {
        sendJson(res, 400, { ok: false, message: "The site's PHP pool was not found" });
        return true;
      }
      setPoolOpcache(pool.settings, body.opcache);
      writeConfigs({ mapBefore, poolsBefore, mapParsed, poolsParsed });
      opcacheChanged = true;
    }
    const state = siteState.update(domain, {
      ...(typeof body.fastcgi_cache === "boolean" ? { fastcgiCache: body.fastcgi_cache } : {}),
      ...(typeof body.redis === "boolean" ? { redis: body.redis } : {}),
      ...(typeof body.opcache === "boolean" ? { opcache: body.opcache } : {}),
      ...(typeof body.backup_enabled === "boolean" ? { backupEnabled: body.backup_enabled } : {}),
      ...(typeof body.image_optimization_enabled === "boolean" ? { imageOptimizationEnabled: body.image_optimization_enabled } : {}),
      ...(typeof body.maintenance_enabled === "boolean" ? { maintenanceEnabled: body.maintenance_enabled } : {}),
      ...(typeof body.notes === "string" ? { notes: body.notes.slice(0, 2000) } : {}),
    });
    if (
      typeof body.fastcgi_cache === "boolean" ||
      typeof body.redis === "boolean" ||
      typeof body.opcache === "boolean"
    ) {
      await validateAndReload(opcacheChanged ? mapBefore : null, opcacheChanged ? poolsBefore : null);
    }
    sendJson(res, 200, { ok: true, state });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/site-state/purge") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const state = siteState.purge(domain);
    await execCommand("docker exec hosting-nginx nginx -s reload");
    sendJson(res, 200, { ok: true, state });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sites/images/optimize") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const mapParsed = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
    const site = mapParsed.hosts[domain];
    if (!site || site.canonicalTo) {
      sendJson(res, 404, { ok: false, message: "Primary site is not configured" });
      return true;
    }
    const directory = String(site.root || "").replace(/^\/var\/www\//, "").replace(/\/$/, "");
    const job = imageOptimizationManager.enqueue([{ host: domain, directory }], req.auth.email);
    sendJson(res, 202, { ok: true, job });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/sites/images/status") {
    sendJson(res, 200, {
      ok: true,
      ...imageOptimizationManager.getStatus(),
      settings: imageOptimizationManager.readSettings(),
    });
    return true;
  }

  if (req.method === "PUT" && requestUrl.pathname === "/api/sites/images/settings") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const settings = imageOptimizationManager.updateSettings({
      enabled: body.enabled,
      scheduleTime: body.schedule_time,
    });
    sendJson(res, 200, { ok: true, settings });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sites/images/optimize-all") {
    const mapParsed = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
    const poolsParsed = parsePools(fs.readFileSync(POOLS_PATH, "utf8"));
    const sites = getSitesWithPools(mapParsed, poolsParsed)
      .filter((site) => !site.isAlias)
      .map((site) => ({
        host: site.host,
        directory: String(site.root || "").replace(/^\/var\/www\//, "").replace(/\/$/, ""),
      }));
    const job = imageOptimizationManager.enqueue(sites, req.auth.email);
    sendJson(res, 202, { ok: true, job, ...imageOptimizationManager.getStatus() });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/maintenance/status") {
    sendJson(res, 200, {
      ok: true,
      status: maintenanceManager.getStatus(),
      settings: maintenanceManager.readSettings(),
    });
    return true;
  }

  if (req.method === "PUT" && requestUrl.pathname === "/api/maintenance/settings") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const settings = maintenanceManager.updateSettings({
      enabled: body.enabled,
      weekday: body.weekday,
      scheduleTime: body.schedule_time,
      operations: body.operations,
      revisionRetention: body.revision_retention,
    });
    sendJson(res, 200, { ok: true, settings });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/maintenance/run") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const requested = new Set(Array.isArray(body.domains) ? body.domains.map((domain) => validateDomain(domain)) : []);
    const mapParsed = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
    const poolsParsed = parsePools(fs.readFileSync(POOLS_PATH, "utf8"));
    const sites = getSitesWithPools(mapParsed, poolsParsed)
      .filter((site) => !site.isAlias && requested.has(site.host) && site.state?.siteType === "wordpress")
      .map((site) => ({
        ...site,
        directory: String(site.root || "").replace(/^\/var\/www\//, "").replace(/\/$/, ""),
        redis: Boolean(site.state?.redis),
      }));
    if (sites.length !== requested.size) {
      sendJson(res, 400, { ok: false, message: "Every selected domain must be a configured WordPress website" });
      return true;
    }
    const job = maintenanceManager.enqueue(sites, body.operations, req.auth.email, "manual", "", {
      revisionRetention: body.revision_retention,
    });
    sendJson(res, 202, { ok: true, job, status: maintenanceManager.getStatus() });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/maintenance/revisions/preview") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const requested = new Set(Array.isArray(body.domains) ? body.domains.map((domain) => validateDomain(domain)) : []);
    const mapParsed = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
    const poolsParsed = parsePools(fs.readFileSync(POOLS_PATH, "utf8"));
    const sites = getSitesWithPools(mapParsed, poolsParsed)
      .filter((site) => !site.isAlias && requested.has(site.host) && site.state?.siteType === "wordpress")
      .map((site) => ({
        ...site,
        directory: String(site.root || "").replace(/^\/var\/www\//, "").replace(/\/$/, ""),
      }));
    if (sites.length !== requested.size || !sites.length) {
      sendJson(res, 400, { ok: false, message: "Every selected domain must be a configured WordPress website" });
      return true;
    }
    sendJson(res, 200, { ok: true, ...(await maintenanceManager.previewRevisions(sites, body.revision_retention)) });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/provision/import-upload") {
    const offset = requestUrl.searchParams.get("offset");
    const totalSize = requestUrl.searchParams.get("total_size");
    if (offset !== null || totalSize !== null) {
      const start = Number(offset);
      const total = Number(totalSize);
      const length = Number(req.headers["content-length"] || 0);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(total) || !Number.isSafeInteger(length)
          || start < 0 || total < 1 || length < 1 || start + length > total) {
        sendJson(res, 400, { ok: false, message: "Upload chunk range is invalid" });
        req.resume();
        return true;
      }
      req.headers["content-range"] = `bytes ${start}-${start + length - 1}/${total}`;
    }
    const result = await provisionImports.upload(
      req,
      requestUrl.searchParams.get("upload_id"),
      requestUrl.searchParams.get("kind"),
      requestUrl.searchParams.get("filename"),
    );
    sendJson(res, 201, { ok: true, upload: result });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname.startsWith("/api/provision/credentials/")
      && requestUrl.pathname.endsWith("/reveal")) {
    const id = requestUrl.pathname.slice("/api/provision/credentials/".length, -"/reveal".length);
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      sendJson(res, 400, { ok: false, message: "Invalid job identifier" });
      return true;
    }
    const job = jobManager.get(id);
    if (!job || job.type !== "site.provision" || !["succeeded", "partially_succeeded"].includes(job.status)) {
      sendJson(res, 409, { ok: false, message: "Provisioning credentials are not available for this job" });
      return true;
    }
    const credentials = provisioningVault.take(id, req.auth.email);
    if (!credentials) {
      sendJson(res, 404, { ok: false, message: "Credentials were already revealed or have expired" });
      return true;
    }
    sendJson(res, 200, { ok: true, credentials }, { "Cache-Control": "no-store" });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/provision") {
    const submitted = JSON.parse((await readBody(req)) || "{}");
    const normalized = validateProvisionRequest(submitted);
    if (submitted.create_update_dns) validateIpv4(submitted.dns_ip);
    if (submitted.apply_dns_preset) dnsPresets.resolveAll(String(submitted.dns_preset_id || ""), normalized.domain);
    if (normalized.siteType === "wordpress" && normalized.sourceMode === "fresh") {
      wordpressPackages.resolve("plugins", submitted.plugin_packages);
      wordpressPackages.resolve("themes", submitted.theme_packages);
    }
    const configured = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
    if (configured.hosts[normalized.domain]) {
      sendJson(res, 409, { ok: false, message: "Domain is already configured" });
      return true;
    }

    let requestRef = "";
    if (normalized.siteType === "wordpress" && normalized.sourceMode === "fresh") {
      requestRef = crypto.randomUUID();
      provisioningVault.put(requestRef, req.auth.email, {
        adminPassword: String(submitted.admin_password || "") || randomPassword(24),
      });
    }
    try {
      const job = jobManager.create(provisioningJobInput({
        body: submitted,
        domain: normalized.domain,
        operator: req.auth.email,
        requestRef,
      }));
      sendJson(res, 202, { ok: true, job: decorateJob(job, req.auth.email) });
    } catch (error) {
      if (requestRef) provisioningVault.remove(requestRef);
      throw error;
    }
    return true;
  }

  if (req.method === "GET" && req.url === "/api/default-pool") {
    sendJson(res, 200, readDefaultPool());
    return true;
  }

  if (req.method === "PUT" && req.url === "/api/default-pool") {
    const presets = readPoolPresets();
    const body = JSON.parse((await readBody(req)) || "{}");
    body.default_tier = normalizeTier(body.default_tier, presets) || "medium";
    writeDefaultPool(body);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && (req.url === "/api/pool-tiers" || req.url === "/api/pool-presets")) {
    sendJson(res, 200, { tiers: readPoolPresets() });
    return true;
  }

  if (req.method === "PUT" && req.url === "/api/pool-presets") {
    const body = JSON.parse((await readBody(req)) || "{}");
    writePoolPresets(body.tiers || {});
    const defaults = readDefaultPool();
    const presets = readPoolPresets();
    if (!normalizeTier(defaults.default_tier, presets)) {
      defaults.default_tier = "medium";
      writeDefaultPool(defaults);
    }
    sendJson(res, 200, { ok: true, tiers: presets });
    return true;
  }

  if (req.method === "GET" && req.url === "/api/pools") {
    const poolsContent = fs.readFileSync(POOLS_PATH, "utf8");
    const mapContent = fs.readFileSync(SITES_MAP_PATH, "utf8");
    const poolsParsed = parsePools(poolsContent);
    const mapParsed = parseSitesMap(mapContent);
    const presets = readPoolPresets();

    const usageByPort = {};
    for (const site of Object.values(mapParsed.hosts)) {
      if (!site.port) continue;
      if (!usageByPort[site.port]) usageByPort[site.port] = [];
      usageByPort[site.port].push(site.host);
    }

    const pools = poolsParsed.sectionOrder.map((name) => {
      const settings = poolsParsed.sections[name] || {};
      const port = Number(settings.listen);
      return {
        name,
        port: Number.isFinite(port) ? port : null,
        settings,
        tier: detectTier(settings, presets),
        hosts: Number.isFinite(port) ? usageByPort[port] || [] : [],
      };
    });

    sendJson(res, 200, { pools });
    return true;
  }

  if (req.method === "POST" && req.url === "/api/pools/upsert") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const name = sanitizeSectionName(String(body.name || "").trim());
    const port = Number(body.port);
    if (!name || !Number.isInteger(port)) {
      sendJson(res, 400, { ok: false, message: "name and integer port are required" });
      return true;
    }

    const mapBefore = fs.readFileSync(SITES_MAP_PATH, "utf8");
    const poolsBefore = fs.readFileSync(POOLS_PATH, "utf8");
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    const defaults = readDefaultPool();
    const presets = readPoolPresets();

    const existingSameName = poolsParsed.sections[name] || null;
    const existingSamePort = poolsParsed.byPort[port] || null;
    if (existingSamePort && existingSamePort.name !== name) {
      sendJson(res, 400, { ok: false, message: `Port ${port} is already used by pool '${existingSamePort.name}'` });
      return true;
    }

    const requestedTier = normalizeTier(body.tier || body.settings?.tier || "", presets) || normalizeTier(defaults.default_tier, presets) || "medium";
    const incomingPool = body.settings || {};
    const oldPort = existingSameName ? Number(existingSameName.listen) : null;
    poolsParsed.sections[name] = buildPoolSettings({
      incomingPool,
      basePool: existingSameName || {},
      defaults,
      tierName: requestedTier,
      root: incomingPool.open_basedir ? "" : "/var/www",
      port,
      presets,
    });

    if (!poolsParsed.sectionOrder.includes(name)) poolsParsed.sectionOrder.push(name);

    if (Number.isInteger(oldPort) && oldPort !== port) {
      for (const hostName of Object.keys(mapParsed.hosts)) {
        const site = mapParsed.hosts[hostName];
        if (site.port === oldPort) {
          site.port = port;
          site.upstream = `hosting-php-fpm:${port}`;
        }
      }
    }

    writeConfigs({ mapBefore, poolsBefore, mapParsed, poolsParsed });
    await validateAndReload(mapBefore, poolsBefore);
    sendJson(res, 200, { ok: true, message: "Pool updated" });
    return true;
  }

  if (req.method === "POST" && req.url === "/api/pools/bulk-upsert") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const items = Array.isArray(body.pools) ? body.pools : [];
    if (items.length === 0) {
      sendJson(res, 400, { ok: false, message: "pools array is required" });
      return true;
    }

    const mapBefore = fs.readFileSync(SITES_MAP_PATH, "utf8");
    const poolsBefore = fs.readFileSync(POOLS_PATH, "utf8");
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    const defaults = readDefaultPool();
    const presets = readPoolPresets();

    const plannedNames = new Set();
    const plannedPorts = new Set();
    for (const raw of items) {
      const name = sanitizeSectionName(String(raw.name || "").trim());
      const port = Number(raw.port);
      if (!name || !Number.isInteger(port)) {
        sendJson(res, 400, { ok: false, message: "Each pool row requires valid name and integer port" });
        return true;
      }
      if (plannedNames.has(name)) {
        sendJson(res, 400, { ok: false, message: `Duplicate pool name '${name}' in payload` });
        return true;
      }
      if (plannedPorts.has(port)) {
        sendJson(res, 400, { ok: false, message: `Duplicate pool port '${port}' in payload` });
        return true;
      }
      plannedNames.add(name);
      plannedPorts.add(port);
    }

    for (const raw of items) {
      const name = sanitizeSectionName(String(raw.name || "").trim());
      const port = Number(raw.port);
      const incomingPool = raw.settings || {};
      const requestedTier = normalizeTier(raw.tier || incomingPool.tier || "", presets) || normalizeTier(defaults.default_tier, presets) || "medium";

      const existingSameName = poolsParsed.sections[name] || null;
      const existingSamePort = poolsParsed.byPort[port] || null;
      if (existingSamePort && existingSamePort.name !== name && !plannedNames.has(existingSamePort.name)) {
        sendJson(res, 400, { ok: false, message: `Port ${port} is already used by pool '${existingSamePort.name}'` });
        return true;
      }

      const oldPort = existingSameName ? Number(existingSameName.listen) : null;
      poolsParsed.sections[name] = buildPoolSettings({
        incomingPool,
        basePool: existingSameName || {},
        defaults,
        tierName: requestedTier,
        root: incomingPool.open_basedir ? "" : "/var/www",
        port,
        presets,
      });
      if (!poolsParsed.sectionOrder.includes(name)) poolsParsed.sectionOrder.push(name);

      if (Number.isInteger(oldPort) && oldPort !== port) {
        for (const hostName of Object.keys(mapParsed.hosts)) {
          const site = mapParsed.hosts[hostName];
          if (site.port === oldPort) {
            site.port = port;
            site.upstream = `hosting-php-fpm:${port}`;
          }
        }
      }
    }

    writeConfigs({ mapBefore, poolsBefore, mapParsed, poolsParsed });
    await validateAndReload(mapBefore, poolsBefore);
    sendJson(res, 200, { ok: true, message: `Updated ${items.length} pool rows` });
    return true;
  }

  if (req.method === "DELETE" && req.url.startsWith("/api/pools/")) {
    const name = sanitizeSectionName(decodeURIComponent(req.url.replace("/api/pools/", "")));
    const mapBefore = fs.readFileSync(SITES_MAP_PATH, "utf8");
    const poolsBefore = fs.readFileSync(POOLS_PATH, "utf8");
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    const section = poolsParsed.sections[name];

    if (!section) {
      sendJson(res, 404, { ok: false, message: "Pool not found" });
      return true;
    }

    const port = Number(section.listen);
    const inUseHosts = Object.values(mapParsed.hosts)
      .filter((s) => s.port === port)
      .map((s) => s.host);

    if (inUseHosts.length > 0) {
      sendJson(res, 400, {
        ok: false,
        message: `Pool '${name}' is used by hosts: ${inUseHosts.join(", ")}`,
      });
      return true;
    }

    delete poolsParsed.sections[name];
    poolsParsed.sectionOrder = poolsParsed.sectionOrder.filter((n) => n !== name);

    writeConfigs({ mapBefore, poolsBefore, mapParsed, poolsParsed });
    await validateAndReload(mapBefore, poolsBefore);
    sendJson(res, 200, { ok: true, message: `Removed pool ${name}` });
    return true;
  }

  if (req.method === "GET" && req.url === "/api/sites") {
    const mapContent = fs.readFileSync(SITES_MAP_PATH, "utf8");
    const poolsContent = fs.readFileSync(POOLS_PATH, "utf8");
    const mapParsed = parseSitesMap(mapContent);
    const poolsParsed = parsePools(poolsContent);
    const sites = getSitesWithPools(mapParsed, poolsParsed);
    sendJson(res, 200, {
      defaultRoot: mapParsed.defaultRoot,
      defaultUpstream: mapParsed.defaultUpstream,
      sites,
    });
    return true;
  }

  if (req.method === "GET" && req.url.startsWith("/api/logs")) {
    return new Promise((resolve) => {
      // PHP-FPM logs to stderr (Docker logs), not a physical file.
      exec(`docker logs --tail 200 hosting-php-fpm`, { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) {
          sendJson(res, 500, { ok: false, message: "Could not read log stream", error: err.message });
        } else {
          // Docker logs output to stderr for stderr streams, so we combine stdout and stderr
          sendJson(res, 200, { ok: true, logs: `${stdout}\n${stderr}`.trim() });
        }
        resolve(true);
      });
    });
  }

  if (req.method === "POST" && req.url === "/api/validate") {
    return new Promise((resolve) => {
      exec("docker exec hosting-nginx nginx -t && docker exec hosting-php-fpm php-fpm -t", { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          sendJson(res, 400, { ok: false, message: "Config validation failed", output: `${stdout}\n${stderr}`.trim() });
        } else {
          sendJson(res, 200, { ok: true, message: "Config validation passed", output: `${stdout}\n${stderr}`.trim() });
        }
        resolve(true);
      });
    });
  }

  if (req.method === "POST" && req.url === "/api/hosts/bulk-upsert") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const items = Array.isArray(body.hosts) ? body.hosts : [];
    if (items.length === 0) {
      sendJson(res, 400, { ok: false, message: "hosts array is required" });
      return true;
    }

    const mapBefore = fs.readFileSync(SITES_MAP_PATH, "utf8");
    const poolsBefore = fs.readFileSync(POOLS_PATH, "utf8");
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);

    for (const raw of items) {
      const host = String(raw.host || "").trim().toLowerCase();
      const root = String(raw.root || "").trim();
      const poolName = sanitizeSectionName(String(raw.pool_name || "").trim());
      const canonicalTo = String(raw.canonical_to || "").trim();
      const addWwwAlias = Boolean(raw.add_www_alias);

      if (!host || !root || !poolName) {
        sendJson(res, 400, { ok: false, message: "Each host row requires host, root, and pool_name" });
        return true;
      }

      const section = poolsParsed.sections[poolName];
      if (!section || !section.listen) {
        sendJson(res, 400, { ok: false, message: `Pool '${poolName}' not found` });
        return true;
      }
      const port = Number(section.listen);
      if (!Number.isInteger(port)) {
        sendJson(res, 400, { ok: false, message: `Pool '${poolName}' has invalid listen port` });
        return true;
      }

      const canonicalTarget = canonicalTo && canonicalTo !== host ? canonicalTo : "";
      mapParsed.hosts[host] = {
        host,
        root,
        port,
        upstream: `hosting-php-fpm:${port}`,
        canonicalTo: canonicalTarget,
      };

      if (addWwwAlias && !host.startsWith("www.")) {
        const alias = `www.${host}`;
        mapParsed.hosts[alias] = {
          host: alias,
          root,
          port,
          upstream: `hosting-php-fpm:${port}`,
          canonicalTo: host,
        };
      } else if (!host.startsWith("www.")) {
        const alias = `www.${host}`;
        if (mapParsed.hosts[alias] && mapParsed.hosts[alias].canonicalTo === host) {
          delete mapParsed.hosts[alias];
        }
      }
    }

    writeConfigs({ mapBefore, poolsBefore, mapParsed, poolsParsed });
    await validateAndReload(mapBefore, poolsBefore);
    sendJson(res, 200, { ok: true, message: `Updated ${items.length} host rows` });
    return true;
  }

  if (req.method === "POST" && (req.url === "/api/hosts/upsert" || req.url === "/api/sites/upsert")) {
    const body = JSON.parse((await readBody(req)) || "{}");
    const host = String(body.host || "").trim().toLowerCase();
    const root = String(body.root || "").trim();
    if (!host || !root) {
      sendJson(res, 400, { ok: false, message: "host and root are required" });
      return true;
    }

    const mapBefore = fs.readFileSync(SITES_MAP_PATH, "utf8");
    const poolsBefore = fs.readFileSync(POOLS_PATH, "utf8");
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    const defaults = readDefaultPool();
    const presets = readPoolPresets();

    const poolName = sanitizeSectionName(String(body.pool_name || "").trim());
    const addWwwAlias = Boolean(body.add_www_alias);
    const canonicalTo = String(body.canonical_to || "").trim();

    let port = Number(body.port);
    if (poolName) {
      const section = poolsParsed.sections[poolName];
      if (!section || !section.listen) {
        sendJson(res, 400, { ok: false, message: `Pool '${poolName}' not found` });
        return true;
      }
      port = Number(section.listen);
    }

    if (!Number.isInteger(port)) {
      sendJson(res, 400, { ok: false, message: "Select a valid pool (or send integer port)" });
      return true;
    }

    const canonicalTarget = canonicalTo && canonicalTo !== host ? canonicalTo : "";
    mapParsed.hosts[host] = {
      host,
      root,
      port,
      upstream: `hosting-php-fpm:${port}`,
      canonicalTo: canonicalTarget,
    };

    if (addWwwAlias && !host.startsWith("www.")) {
      const alias = `www.${host}`;
      mapParsed.hosts[alias] = {
        host: alias,
        root,
        port,
        upstream: `hosting-php-fpm:${port}`,
        canonicalTo: host,
      };
    }

    if (body.remove_www_alias && !host.startsWith("www.")) {
      const alias = `www.${host}`;
      if (mapParsed.hosts[alias] && mapParsed.hosts[alias].canonicalTo === host) {
        delete mapParsed.hosts[alias];
      }
    }

    if (!poolName) {
      const existingPool = poolsParsed.byPort[port];
      const sectionName = existingPool ? existingPool.name : sanitizeSectionName(host);
      const incomingPool = body.pool || {};
      const requestedTier = normalizeTier(body.pool_tier || incomingPool.tier || "", presets);
      const effectiveTier = requestedTier || normalizeTier(defaults.default_tier, presets) || "medium";
      const basePool = existingPool ? existingPool.settings : {};
      poolsParsed.sections[sectionName] = buildPoolSettings({
        incomingPool,
        basePool,
        defaults,
        tierName: effectiveTier,
        root,
        port,
        presets,
      });
      if (!poolsParsed.sectionOrder.includes(sectionName)) poolsParsed.sectionOrder.push(sectionName);
    }

    writeConfigs({ mapBefore, poolsBefore, mapParsed, poolsParsed });
    await validateAndReload(mapBefore, poolsBefore);
    sendJson(res, 200, { ok: true, message: "Host updated" });
    return true;
  }

  if (req.method === "DELETE" && (req.url.startsWith("/api/sites/") || req.url.startsWith("/api/hosts/"))) {
    const host = decodeURIComponent(req.url.replace("/api/sites/", "").replace("/api/hosts/", ""));
    const mapBefore = fs.readFileSync(SITES_MAP_PATH, "utf8");
    const poolsBefore = fs.readFileSync(POOLS_PATH, "utf8");
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    const removed = mapParsed.hosts[host];

    if (!removed) {
      sendJson(res, 404, { ok: false, message: "Host not found" });
      return true;
    }

    delete mapParsed.hosts[host];
    for (const sourceHost of Object.keys(mapParsed.hosts)) {
      if (mapParsed.hosts[sourceHost].canonicalTo === host) mapParsed.hosts[sourceHost].canonicalTo = "";
    }

    const stillUsed = Object.values(mapParsed.hosts).some((s) => s.port === removed.port);
    if (!stillUsed && removed.port && poolsParsed.byPort[removed.port]) {
      const secName = poolsParsed.byPort[removed.port].name;
      delete poolsParsed.sections[secName];
      poolsParsed.sectionOrder = poolsParsed.sectionOrder.filter((s) => s !== secName);
    }

    writeConfigs({ mapBefore, poolsBefore, mapParsed, poolsParsed });
    await validateAndReload(mapBefore, poolsBefore);
    sendJson(res, 200, { ok: true, message: `Removed ${host}` });
    return true;
  }

  if (req.method === "POST" && req.url.startsWith("/api/actions/")) {
    const action = req.url.replace("/api/actions/", "");
    if (!Object.prototype.hasOwnProperty.call(ACTION_CMDS, action)) {
      sendJson(res, 404, { ok: false, message: "Unknown action" });
      return true;
    }
    const result = await execAction(action);
    sendJson(res, result.ok ? 200 : 400, result);
    return true;
  }

  return false;
}

async function handleAuthApi(req, res) {
  const requestUrl = new URL(req.url, "http://ui-manager.local");
  if (req.method === "GET" && requestUrl.pathname === "/api/auth/status") {
    const session = auth.getSession(req);
    if (!session) {
      sendJson(res, 200, { authenticated: false });
      return true;
    }
    const account = auth.readAccount();
    sendJson(res, 200, {
      authenticated: true,
      email: session.email,
      csrf: session.csrf,
      mustChangePassword: Boolean(account.mustChangePassword),
    });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/auth/login") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = auth.login(req, body.email, body.password);
    sendJson(
      res,
      200,
      {
        authenticated: true,
        email: result.session.email,
        csrf: result.session.csrf,
        mustChangePassword: result.mustChangePassword,
      },
      { "Set-Cookie": auth.cookie(req, result.session.id) },
    );
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
    const session = auth.getSession(req);
    if (!session || req.headers["x-csrf-token"] !== session.csrf) {
      sendJson(res, 403, { ok: false, message: "Invalid CSRF token" });
      return true;
    }
    auth.logout(req);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": auth.clearCookie(req) });
    return true;
  }

  if (req.method === "PUT" && requestUrl.pathname === "/api/auth/account") {
    const session = auth.getSession(req);
    if (!session) {
      sendJson(res, 401, { ok: false, message: "Authentication required" });
      return true;
    }
    if (req.headers["x-csrf-token"] !== session.csrf) {
      sendJson(res, 403, { ok: false, message: "Invalid CSRF token" });
      return true;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    if (body.new_password && body.new_password !== body.confirm_password) {
      sendJson(res, 400, { ok: false, message: "New passwords do not match" });
      return true;
    }
    const updated = auth.updateAccount(
      session,
      body.current_password,
      body.email,
      body.new_password,
    );
    sendJson(res, 200, { ok: true, ...updated });
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      if (req.url.startsWith("/api/auth/")) {
        const handledAuth = await handleAuthApi(req, res);
        if (!handledAuth) sendJson(res, 404, { ok: false, message: "Not found" });
        return;
      }
      const session = auth.getSession(req);
      if (!session) {
        sendJson(res, 401, { ok: false, message: "Authentication required" });
        return;
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-csrf-token"] !== session.csrf) {
        sendJson(res, 403, { ok: false, message: "Invalid CSRF token" });
        return;
      }
      req.auth = session;
      const handled = await handleApi(req, res);
      if (!handled) sendJson(res, 404, { ok: false, message: "Not found" });
      return;
    }

    const fp = resolvePublicFile("/app/public", req.url);
    if (!fp || !fs.existsSync(fp)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(fp).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(fs.readFileSync(fp));
  } catch (err) {
    sendJson(res, err.statusCode || 500, {
      ok: false,
      message: err.message,
      details: err.details || err.output || "",
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`UI manager listening on :${PORT}`);
  notificationManager.start(jobManager);
  healthMonitor.start();
  jobManager.start();
  backupManager.start();
  imageOptimizationManager.startScheduler();
  maintenanceManager.startScheduler();
  if (fs.existsSync(performanceSettings.path)) {
    setTimeout(async () => {
      const settings = performanceSettings.read();
      const snapshot = performanceSettings.snapshot();
      try {
        performanceSettings.applyFiles(settings);
        const filesChanged = snapshot.phpContent !== fs.readFileSync(performanceSettings.phpIniPath, "utf8")
          || snapshot.nginxContent !== fs.readFileSync(performanceSettings.nginxPath, "utf8")
          || snapshot.nginxDefaultContent !== fs.readFileSync(performanceSettings.nginxDefaultPath, "utf8");
        if (filesChanged) await validateAndReload();
        await applyDynamicPerformance(settings);
      } catch (error) {
        performanceSettings.restore(snapshot);
        try {
          await validateAndReload();
        } catch (rollbackError) {
          console.error(`Could not reload restored startup settings: ${rollbackError.message}`);
        }
        console.error(`Could not reapply managed performance settings: ${error.message}`);
      }
    }, 15_000);
  }
});
