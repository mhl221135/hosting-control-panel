const fs = require("fs");
const path = require("path");
const http = require("http");
const { exec, execFile } = require("child_process");
const { AuthStore } = require("./lib/auth");
const { IntegrationSettings } = require("./lib/integration-settings");
const { CloudflareClient, NpmClient } = require("./lib/integrations");
const {
  createDatabase,
  installWordPress,
  optimizeImages,
  prepareSiteDirectory,
  randomPassword,
  setRedis,
  updateWordPressUrl,
  validateDomain,
} = require("./lib/provisioner");
const { SiteState } = require("./lib/site-state");
const { BackupManager } = require("./lib/backup-manager");
const { DnsPresetStore } = require("./lib/dns-presets");
const { IpAddressStore, validateIpv4 } = require("./lib/ip-addresses");
const { PerformanceSettings } = require("./lib/performance-settings");
const { annotateSiteAliases } = require("./lib/runtime-config");
const { ImageOptimizationManager } = require("./lib/image-optimization-manager");
const { resolvePublicFile } = require("./lib/static-files");
const { WordPressPackageStore } = require("./lib/wordpress-packages");
const { StatsCollector } = require("./lib/stats-collector");

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
const npm = new NpmClient(() => integrationSettings.resolved());
const cloudflare = new CloudflareClient(() => integrationSettings.resolved());
const dnsPresets = new DnsPresetStore(DATA_DIR);
const wordpressPackages = new WordPressPackageStore(DATA_DIR);
const ipAddresses = new IpAddressStore(DATA_DIR);
const performanceSettings = new PerformanceSettings({
  dataDir: DATA_DIR,
  phpIniPath: PHP_INI_PATH,
  nginxPath: NGINX_CONFIG_PATH,
  nginxDefaultPath: NGINX_DEFAULT_PATH,
});
const siteState = new SiteState(DATA_DIR, CACHE_MAP_PATH);
siteState.renderCacheMap();
const backupManager = new BackupManager({
  dataDir: DATA_DIR,
  backupsRoot: BACKUPS_ROOT,
  websitesRoot: WEBSITES_ROOT,
  appDataRoot: APP_DATA_ROOT,
  mysqlContainer: process.env.MYSQL_CONTAINER || "hosting-db",
  phpContainer: process.env.PHP_CONTAINER || "hosting-php-fpm",
  siteProvider: async () => {
    const mapParsed = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
    const poolsParsed = parsePools(fs.readFileSync(POOLS_PATH, "utf8"));
    return getSitesWithPools(mapParsed, poolsParsed);
  },
});
const imageOptimizationManager = new ImageOptimizationManager({
  dataDir: DATA_DIR,
  backupManager,
  optimizer: optimizeImages,
});
const statsCollector = new StatsCollector({
  websitesRoot: WEBSITES_ROOT,
  npmLogsRoot: path.join(APP_DATA_ROOT, "npm/data/logs"),
});

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
  return {
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
      state: states[s.host] || {
        fastcgiCache: false,
        cacheVersion: 1,
        redis: false,
        opcache: true,
        backupEnabled: false,
        notes: "",
      },
    };
  });
  return annotateSiteAliases(sites);
}

function writeConfigs({ mapBefore, poolsBefore, mapParsed, poolsParsed }) {
  backupFile(SITES_MAP_PATH, mapBefore);
  backupFile(POOLS_PATH, poolsBefore);
  fs.writeFileSync(SITES_MAP_PATH, renderSitesMap(mapParsed), "utf8");
  fs.writeFileSync(POOLS_PATH, renderPools(poolsParsed), "utf8");
}

async function handleApi(req, res) {
  const requestUrl = new URL(req.url, "http://ui-manager.local");

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

  if (req.method === "GET" && requestUrl.pathname === "/api/stats/site") {
    const domain = validateDomain(requestUrl.searchParams.get("domain"));
    const mapParsed = parseSitesMap(fs.readFileSync(SITES_MAP_PATH, "utf8"));
    const poolsParsed = parsePools(fs.readFileSync(POOLS_PATH, "utf8"));
    const site = getSitesWithPools(mapParsed, poolsParsed)
      .find((item) => item.host === domain && !item.isAlias);
    if (!site) {
      sendJson(res, 404, { ok: false, message: "Primary site is not configured" });
      return true;
    }
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
    sendJson(res, 200, {
      ok: true,
      ...(await statsCollector.site({ domain, directory, npmHostIds }, requestUrl.searchParams.get("refresh") === "1")),
    });
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
    sendJson(res, 201, await backupManager.runSite(site));
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/backups/app-data") {
    sendJson(res, 201, await backupManager.runAppData());
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
    sendJson(res, 200, await backupManager.runSiteRestore(site, String(body.backup_id || "")));
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
    const host = await npm.ensureHost(domains, Boolean(body.issue_ssl));
    sendJson(res, 200, { ok: true, host });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/npm/certificates/renew") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const certificate = await npm.renewCertificate(body.certificate_id);
    sendJson(res, 200, { ok: true, certificate });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/cloudflare/records") {
    const domain = validateDomain(requestUrl.searchParams.get("domain"));
    sendJson(res, 200, await cloudflare.records(domain));
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
    if (typeof body.redis === "boolean" && body.redis !== Boolean(siteState.get(domain).redis)) {
      const directory = String(site.root || "").replace(/^\/var\/www\//, "").replace(/\/$/, "");
      await setRedis(directory, domain, body.redis);
    }
    let opcacheChanged = false;
    let mapBefore = null;
    let poolsBefore = null;
    if (typeof body.opcache === "boolean" && body.opcache !== Boolean(siteState.get(domain).opcache)) {
      mapBefore = mapContent;
      poolsBefore = fs.readFileSync(POOLS_PATH, "utf8");
      const poolsParsed = parsePools(poolsBefore);
      const pool = poolsParsed.byPort[site.port];
      if (!pool) {
        sendJson(res, 400, { ok: false, message: "The site's PHP pool was not found" });
        return true;
      }
      pool.settings["php_admin_value[opcache.enable]"] = body.opcache ? "1" : "0";
      writeConfigs({ mapBefore, poolsBefore, mapParsed, poolsParsed });
      opcacheChanged = true;
    }
    const state = siteState.update(domain, {
      ...(typeof body.fastcgi_cache === "boolean" ? { fastcgiCache: body.fastcgi_cache } : {}),
      ...(typeof body.redis === "boolean" ? { redis: body.redis } : {}),
      ...(typeof body.opcache === "boolean" ? { opcache: body.opcache } : {}),
      ...(typeof body.backup_enabled === "boolean" ? { backupEnabled: body.backup_enabled } : {}),
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
    const result = await backupManager.withLock(
      { type: "images", domain, label: `Optimize images ${domain}` },
      () => optimizeImages(directory),
    );
    sendJson(res, 200, { ok: true, domain, ...result });
    return true;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/sites/images/status") {
    sendJson(res, 200, { ok: true, ...imageOptimizationManager.getStatus() });
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
    const status = imageOptimizationManager.start(sites);
    sendJson(res, 202, { ok: true, ...status });
    return true;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/provision") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const domain = validateDomain(body.domain);
    const directory = String(body.directory || domain).trim();
    const adminEmail = String(body.admin_email || "").trim().toLowerCase();
    const adminUser = String(body.admin_user || "admin").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
      sendJson(res, 400, { ok: false, message: "Enter a valid WordPress administrator email" });
      return true;
    }
    if (!/^[a-zA-Z0-9_.@-]{3,60}$/.test(adminUser)) {
      sendJson(res, 400, { ok: false, message: "WordPress administrator username is invalid" });
      return true;
    }
    const pluginPackages = wordpressPackages.resolve("plugins", body.plugin_packages);
    const themePackages = wordpressPackages.resolve("themes", body.theme_packages);
    const dnsIp = body.create_update_dns ? validateIpv4(body.dns_ip) : "";
    const presetRecords = body.apply_dns_preset
      ? dnsPresets.resolveAll(String(body.dns_preset_id || ""), domain)
      : [];

    const mapBefore = fs.readFileSync(SITES_MAP_PATH, "utf8");
    const poolsBefore = fs.readFileSync(POOLS_PATH, "utf8");
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    if (mapParsed.hosts[domain]) {
      sendJson(res, 409, { ok: false, message: "Domain is already configured" });
      return true;
    }

    prepareSiteDirectory(WEBSITES_ROOT, directory);
    const usedPorts = Object.values(poolsParsed.sections)
      .map((pool) => Number(pool.listen))
      .filter(Number.isInteger);
    const port = Math.max(9000, ...usedPorts) + 1;
    const poolName = sanitizeSectionName(domain);
    const defaults = readDefaultPool();
    const presets = readPoolPresets();
    const tier = normalizeTier(body.pool_tier, presets) || normalizeTier(defaults.default_tier, presets) || "medium";
    const root = `/var/www/${directory}`;
    poolsParsed.sections[poolName] = buildPoolSettings({
      incomingPool: {},
      basePool: {},
      defaults,
      tierName: tier,
      root,
      port,
      presets,
    });
    poolsParsed.sections[poolName]["php_admin_value[opcache.enable]"] = body.opcache === false ? "0" : "1";
    poolsParsed.sectionOrder.push(poolName);
    mapParsed.hosts[domain] = {
      host: domain,
      root,
      port,
      upstream: `hosting-php-fpm:${port}`,
      canonicalTo: "",
    };
    const domains = [domain];
    if (body.add_www && !domain.startsWith("www.")) {
      const alias = `www.${domain}`;
      domains.push(alias);
      mapParsed.hosts[alias] = {
        host: alias,
        root,
        port,
        upstream: `hosting-php-fpm:${port}`,
        canonicalTo: domain,
      };
    }

    writeConfigs({ mapBefore, poolsBefore, mapParsed, poolsParsed });
    const steps = [];
    try {
      await validateAndReload(mapBefore, poolsBefore);
      steps.push({ name: "runtime", status: "complete" });
      const database = await createDatabase(domain, integrationSettings.resolved());
      steps.push({ name: "database", status: "complete", database: database.name });
      const adminPassword = String(body.admin_password || "") || randomPassword(24);
      await installWordPress({
        domain,
        directory,
        database,
        title: String(body.title || domain),
        adminEmail,
        adminUser,
        adminPassword,
        redis: Boolean(body.redis),
        useHttps: false,
        commentsEnabled: Boolean(body.enable_comments),
        keepDefaultPlugins: Boolean(body.keep_default_plugins),
        keepDefaultThemes: Boolean(body.keep_default_themes),
        pluginPackages,
        themePackages,
      });
      steps.push({ name: "wordpress", status: "complete" });

      siteState.update(domain, {
        fastcgiCache: Boolean(body.fastcgi_cache),
        redis: Boolean(body.redis),
        opcache: body.opcache !== false,
        backupEnabled: Boolean(body.scheduled_backup),
        cacheVersion: 1,
        notes: String(body.notes || "").slice(0, 2000),
      });
      await execCommand("docker exec hosting-nginx nginx -s reload");

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
            await updateWordPressUrl(directory, domain, true);
            steps.push({ name: "https", status: "complete" });
          }
        } catch (error) {
          steps.push({ name: "npm", status: "warning", message: error.message });
        }
      }

      sendJson(res, 201, {
        ok: true,
        domain,
        directory,
        port,
        database: { name: database.name, user: database.user, password: database.password },
        wordpress: { adminUser, adminPassword, adminEmail },
        npmHost,
        steps,
      });
    } catch (error) {
      steps.push({ name: "failed", status: "failed", message: error.message });
      sendJson(res, error.statusCode || 500, {
        ok: false,
        message: error.message,
        details: error.details || error.output || "",
        steps,
      });
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
  backupManager.start();
  if (fs.existsSync(performanceSettings.path)) {
    setTimeout(() => {
      applyDynamicPerformance(performanceSettings.read()).catch((error) => {
        console.error(`Could not reapply dynamic performance settings: ${error.message}`);
      });
    }, 15_000);
  }
});
