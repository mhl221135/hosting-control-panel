const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function execFileResult(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout || 20_000, maxBuffer: options.maxBuffer || 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.details = String(stderr || stdout || "").trim();
          reject(error);
          return;
        }
        resolve(String(stdout || ""));
      });
  });
}

function number(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseMeminfo(content) {
  const values = {};
  for (const line of String(content || "").split("\n")) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)/);
    if (match) values[match[1]] = Number(match[2]) * 1024;
  }
  return values;
}

function parseDockerStats(content) {
  return String(content || "").split("\n").filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return [{
        name: row.Name || row.Container || "unknown",
        cpuPercent: number(row.CPUPerc),
        memoryPercent: number(row.MemPerc),
        memoryUsage: row.MemUsage || "-",
        networkIo: row.NetIO || "-",
        blockIo: row.BlockIO || "-",
        pids: number(row.PIDs),
      }];
    } catch {
      return [];
    }
  });
}

function parsePhpPools(content) {
  const pools = {};
  for (const line of String(content || "").split("\n").slice(1)) {
    const match = line.match(/^\s*\d+\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+\S+\s+(.+)$/);
    if (!match) continue;
    const poolMatch = match[4].match(/php-fpm:\s+pool\s+([^\s]+)/);
    if (!poolMatch) continue;
    const name = poolMatch[1];
    const current = pools[name] || { name, workers: 0, cpuPercent: 0, memoryPercent: 0, rssBytes: 0 };
    current.workers += 1;
    current.cpuPercent += Number(match[1]);
    current.memoryPercent += Number(match[2]);
    current.rssBytes += Number(match[3]) * 1024;
    pools[name] = current;
  }
  return Object.values(pools).map((pool) => ({
    ...pool,
    cpuPercent: Number(pool.cpuPercent.toFixed(1)),
    memoryPercent: Number(pool.memoryPercent.toFixed(1)),
  })).sort((left, right) => right.cpuPercent - left.cpuPercent || right.rssBytes - left.rssBytes);
}

function parseRedisInfo(content) {
  const values = {};
  for (const line of String(content || "").split("\n")) {
    const index = line.indexOf(":");
    if (index > 0 && !line.startsWith("#")) values[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  const hits = number(values.keyspace_hits);
  const misses = number(values.keyspace_misses);
  return {
    connectedClients: number(values.connected_clients),
    usedMemoryBytes: number(values.used_memory),
    usedMemoryHuman: values.used_memory_human || "0B",
    maxMemoryBytes: number(values.maxmemory),
    maxMemoryHuman: values.maxmemory_human || "0B",
    operationsPerSecond: number(values.instantaneous_ops_per_sec),
    keys: Object.entries(values)
      .filter(([key]) => /^db\d+$/.test(key))
      .reduce((total, [, value]) => total + number(String(value).match(/keys=(\d+)/)?.[1]), 0),
    hits,
    misses,
    hitRate: hits + misses ? Number(((hits / (hits + misses)) * 100).toFixed(1)) : 0,
    evictedKeys: number(values.evicted_keys),
    rejectedConnections: number(values.rejected_connections),
  };
}

function parseOpcacheStatus(content) {
  const body = String(content || "").split(/\r?\n\r?\n/).slice(-1)[0].trim();
  if (!body) throw new Error("OPcache probe returned an empty response");
  const value = JSON.parse(body);
  if (!value || typeof value !== "object") throw new Error("OPcache probe returned invalid data");
  return value;
}

function tailText(filePath, maxBytes = 1024 * 1024) {
  if (!fs.existsSync(filePath)) return "";
  const descriptor = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, Math.max(0, size - length));
    const content = buffer.toString("utf8");
    return size > maxBytes ? content.slice(content.indexOf("\n") + 1) : content;
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseAccessLogs(contents, maxLines = 2000) {
  const lines = contents.flatMap((content) => String(content || "").split("\n")).filter(Boolean).slice(-maxLines);
  const ips = new Map();
  const paths = new Map();
  const methods = new Map();
  const statusGroups = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 };
  let bytes = 0;
  let parsed = 0;
  let latestAt = "";
  const pattern = /^\[([^\]]+)\] - \S+ (\d{3}) - (\S+) \S+ (\S+) "([^"]*)" \[Client ([^\]]+)\] \[Length (\d+)\]/;
  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) continue;
    latestAt = match[1];
    const status = Number(match[2]);
    const method = match[3];
    const host = match[4];
    const requestPath = match[5];
    const ip = match[6];
    const length = Number(match[7]);
    parsed += 1;
    bytes += length;
    ips.set(ip, (ips.get(ip) || 0) + 1);
    paths.set(requestPath, (paths.get(requestPath) || 0) + 1);
    methods.set(method, (methods.get(method) || 0) + 1);
    const group = status >= 200 && status < 600 ? `${Math.floor(status / 100)}xx` : "other";
    statusGroups[group] = (statusGroups[group] || 0) + 1;
    if (!host) statusGroups.other += 0;
  }
  const top = (map, key) => [...map.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([value, requests]) => ({ [key]: value, requests }));
  return {
    requests: parsed,
    sampledLines: lines.length,
    bytes,
    latestAt,
    statusGroups,
    methods: top(methods, "method"),
    topIps: top(ips, "ip"),
    topPaths: top(paths, "path"),
  };
}

class StatsCollector {
  constructor(options = {}) {
    this.websitesRoot = options.websitesRoot || "/srv/websites";
    this.npmLogsRoot = options.npmLogsRoot || "/srv/app-data/npm/data/logs";
    this.exec = options.exec || execFileResult;
    this.now = options.now || (() => Date.now());
    this.runtimeTtlMs = options.runtimeTtlMs || 30_000;
    this.siteTtlMs = options.siteTtlMs || 5 * 60_000;
    this.runtimeCache = null;
    this.siteCache = new Map();
  }

  async cached(cache, ttl, force, load) {
    if (!force && cache?.value && this.now() - cache.at < ttl) return { ...cache.value, cached: true };
    const value = await load();
    return { value: { ...value, cached: false }, entry: { at: this.now(), value } };
  }

  serverSnapshot() {
    let load = [0, 0, 0];
    let memory = {};
    let uptimeSeconds = 0;
    try { load = fs.readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/).slice(0, 3).map(Number); } catch {}
    try { memory = parseMeminfo(fs.readFileSync("/proc/meminfo", "utf8")); } catch {}
    try { uptimeSeconds = number(fs.readFileSync("/proc/uptime", "utf8").split(/\s+/)[0]); } catch {}
    let disk = { totalBytes: 0, freeBytes: 0, usedBytes: 0 };
    try {
      if (typeof fs.statfsSync === "function") {
        const stats = fs.statfsSync(this.websitesRoot);
        disk = {
          totalBytes: stats.blocks * stats.bsize,
          freeBytes: stats.bavail * stats.bsize,
          usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
        };
      }
    } catch {}
    return {
      load1: load[0] || 0,
      load5: load[1] || 0,
      load15: load[2] || 0,
      memoryTotalBytes: memory.MemTotal || 0,
      memoryAvailableBytes: memory.MemAvailable || 0,
      memoryUsedBytes: Math.max(0, (memory.MemTotal || 0) - (memory.MemAvailable || 0)),
      uptimeSeconds,
      disk,
    };
  }

  async runtime(force = false) {
    const cached = await this.cached(this.runtimeCache, this.runtimeTtlMs, force, async () => {
      const loadDockerStats = async () => {
        const output = await this.exec("docker", ["ps", "-a", "--filter", "name=hosting-", "--format", "{{.Names}}"]);
        const names = output.split("\n").map((name) => name.trim()).filter((name) => name.startsWith("hosting-"));
        if (!names.length) return "";
        return this.exec("docker", ["stats", "--no-stream", "--format", "{{json .}}", ...names], { timeout: 25_000 });
      };
      const [dockerStats, phpTop, redisInfo, fastcgiSize, opcacheStatus] = await Promise.allSettled([
        loadDockerStats(),
        this.exec("docker", ["top", "hosting-php-fpm", "-eo", "pid,pcpu,pmem,rss,etime,args"]),
        this.exec("docker", ["exec", "hosting-redis", "redis-cli", "--raw", "INFO"]),
        this.exec("docker", ["exec", "hosting-nginx", "du", "-sk", "/var/cache/nginx/fastcgi"], { timeout: 30_000 }),
        this.exec("docker", [
          "exec",
          "-e", "SCRIPT_FILENAME=/global/opcache-status.php",
          "-e", "SCRIPT_NAME=/opcache-status.php",
          "-e", "REQUEST_METHOD=GET",
          "-e", "REQUEST_URI=/opcache-status.php",
          "-e", "SERVER_PROTOCOL=HTTP/1.1",
          "-e", "GATEWAY_INTERFACE=CGI/1.1",
          "-e", "REDIRECT_STATUS=200",
          "hosting-php-fpm", "cgi-fcgi", "-bind", "-connect", "127.0.0.1:9000",
        ]),
      ]);
      const warnings = [];
      const value = (result, fallback, label, parser) => {
        if (result.status === "fulfilled") return parser(result.value);
        warnings.push(`${label}: ${result.reason.message}`);
        return fallback;
      };
      return {
        generatedAt: new Date(this.now()).toISOString(),
        server: this.serverSnapshot(),
        containers: value(dockerStats, [], "Container statistics", parseDockerStats)
          .filter((container) => container.name.startsWith("hosting-")),
        phpPools: value(phpTop, [], "PHP pool statistics", parsePhpPools),
        redis: value(redisInfo, null, "Redis statistics", parseRedisInfo),
        fastcgi: {
          cacheBytes: value(fastcgiSize, 0, "FastCGI cache size", (output) => number(output.split(/\s+/)[0]) * 1024),
        },
        opcache: value(opcacheStatus, null, "OPcache statistics", parseOpcacheStatus),
        warnings,
      };
    });
    if (cached.entry) this.runtimeCache = cached.entry;
    return cached.value || cached;
  }

  safeWebsitePath(directory) {
    const value = String(directory || "").trim();
    if (!value || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
      throw new Error("Website directory is invalid");
    }
    const root = path.resolve(this.websitesRoot);
    const target = path.resolve(root, value);
    if (path.dirname(target) !== root) throw new Error("Website directory is outside the websites root");
    return target;
  }

  async site(options, force = false) {
    const domain = String(options.domain || "").toLowerCase();
    const cacheKey = `${domain}:${(options.npmHostIds || []).join(",")}`;
    const cached = await this.cached(this.siteCache.get(cacheKey), this.siteTtlMs, force, async () => {
      const warnings = [];
      let diskBytes = 0;
      try {
        const output = await this.exec("du", ["-sk", this.safeWebsitePath(options.directory)], { timeout: 60_000 });
        diskBytes = number(output.split(/\s+/)[0]) * 1024;
      } catch (error) {
        warnings.push(`Website disk usage: ${error.message}`);
      }
      const logs = [];
      for (const id of options.npmHostIds || []) {
        const base = path.join(this.npmLogsRoot, `proxy-host-${Number(id)}_access.log`);
        if (Number.isInteger(Number(id)) && fs.existsSync(base)) logs.push(tailText(base));
      }
      return {
        generatedAt: new Date(this.now()).toISOString(),
        domain,
        diskBytes,
        traffic: parseAccessLogs(logs),
        warnings,
      };
    });
    if (cached.entry) this.siteCache.set(cacheKey, cached.entry);
    return cached.value || cached;
  }
}

module.exports = {
  StatsCollector,
  parseAccessLogs,
  parseDockerStats,
  parsePhpPools,
  parseRedisInfo,
  parseOpcacheStatus,
};
