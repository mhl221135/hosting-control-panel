const fs = require("fs");
const path = require("path");
const { parsePools, parseSitesMap, renderPools, renderSitesMap } = require("./runtime-config");

const MIN_PORT = 1;
const MAX_PORT = 65535;
const DEFAULT_PORT_START = 9000;
const DEFAULT_VERIFY_RETRIES = 10;
const DEFAULT_VERIFY_DELAY_MS = 300;
const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;
const DEFAULT_LOCK_RETRY_MS = 100;
const DEFAULT_STALE_LOCK_MS = 10 * 60_000;

function allocatePort(existingPorts, { start = DEFAULT_PORT_START, end = MAX_PORT } = {}) {
  const hasStart = start !== undefined && start !== null && start !== "";
  const hasEnd = end !== undefined && end !== null && end !== "";
  const startValue = Number(start);
  const endValue = Number(end);
  const startValid = hasStart && Number.isInteger(startValue) && startValue >= MIN_PORT && startValue <= MAX_PORT;
  const endValid = hasEnd && Number.isInteger(endValue) && endValue >= MIN_PORT && endValue <= MAX_PORT;
  if (hasStart && !startValid) {
    throw Object.assign(new Error("Invalid port range start"), { statusCode: 400 });
  }
  if (hasEnd && !endValid) {
    throw Object.assign(new Error("Invalid port range end"), { statusCode: 400 });
  }
  const lower = startValid ? startValue : DEFAULT_PORT_START;
  const upper = endValid ? endValue : MAX_PORT;
  if (lower > upper) {
    throw Object.assign(new Error("Invalid port range"), { statusCode: 400 });
  }
  const used = new Set();
  for (const value of Array.isArray(existingPorts) ? existingPorts : []) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= MIN_PORT && parsed <= MAX_PORT) used.add(parsed);
  }
  for (let port = lower; port <= upper; port += 1) {
    if (!used.has(port)) return port;
  }
  throw Object.assign(new Error("No free PHP-FPM listen port available in the requested range"), {
    statusCode: 409,
  });
}

function collectPoolPorts(poolsParsed) {
  const ports = new Set();
  for (const name of poolsParsed?.sectionOrder || []) {
    const port = Number(poolsParsed.sections?.[name]?.listen);
    if (Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function upstreamPort(upstream) {
  const match = String(upstream || "").match(/^[^:]+:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function validateRuntimeModel(mapParsed, poolsParsed) {
  const sections = poolsParsed?.sections || {};
  const order = poolsParsed?.sectionOrder || [];
  if ((poolsParsed?.duplicateSections || []).length) {
    throw Object.assign(new Error("Duplicate PHP-FPM pool sections are not allowed"), { statusCode: 400 });
  }
  if ((mapParsed?.duplicateEntries || []).length) {
    throw Object.assign(new Error("Duplicate host entries in sites.map are not allowed"), { statusCode: 400 });
  }
  const seenNames = new Set();
  const seenPorts = new Map();
  for (const name of order) {
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(name)) {
      throw Object.assign(new Error("A PHP-FPM pool name contains unsupported characters"), { statusCode: 400 });
    }
    if (seenNames.has(name)) {
      throw Object.assign(new Error(`Duplicate pool section '${name}'`), { statusCode: 400 });
    }
    seenNames.add(name);
    if (!Object.prototype.hasOwnProperty.call(sections, name)) {
      throw Object.assign(new Error(`Pool section '${name}' is missing from pool state`), { statusCode: 400 });
    }
    const port = Number(sections[name].listen);
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
      throw Object.assign(new Error(`Pool '${name}' has an invalid listen port`), { statusCode: 400 });
    }
    if (seenPorts.has(port)) {
      throw Object.assign(
        new Error(`Duplicate listen port ${port} for pools '${seenPorts.get(port)}' and '${name}'`),
        { statusCode: 400 },
      );
    }
    seenPorts.set(port, name);
  }
  for (const name of Object.keys(sections)) {
    if (!order.includes(name)) {
      throw Object.assign(new Error(`Pool section '${name}' is absent from the section order`), { statusCode: 400 });
    }
  }
  const hosts = mapParsed?.hosts || {};
  for (const site of Object.values(hosts)) {
    const host = String(site.host || "");
    const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
    if (!hostnamePattern.test(host)) {
      throw Object.assign(new Error("A runtime host contains an invalid hostname"), { statusCode: 400 });
    }
    const root = String(site.root || "");
    if (!root.startsWith("/var/www/") || /[\r\n\0\\]/.test(root) || root.split("/").includes("..")) {
      throw Object.assign(new Error("A runtime host contains an invalid document root"), { statusCode: 400 });
    }
    const canonical = String(site.canonicalTo || "");
    if (canonical && !hostnamePattern.test(canonical)) {
      throw Object.assign(new Error("A runtime host contains an invalid canonical hostname"), { statusCode: 400 });
    }
    if (!site.phpEnabled) continue;
    const port = Number(site.port);
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
      throw Object.assign(new Error(`PHP-enabled host '${site.host}' has an invalid upstream port`), { statusCode: 400 });
    }
    if (!seenPorts.has(port)) {
      throw Object.assign(new Error(`PHP-enabled host '${site.host}' references a missing pool port ${port}`), {
        statusCode: 400,
      });
    }
    const parsedUpstreamPort = upstreamPort(site.upstream);
    if (parsedUpstreamPort === null || parsedUpstreamPort !== port) {
      throw Object.assign(
        new Error(`Host '${site.host}' upstream '${site.upstream}' disagrees with its pool port ${port}`),
        { statusCode: 400 },
      );
    }
  }
  return true;
}

function probePort(port, { host = "hosting-php-fpm", timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, createConnection } = {}) {
  const connect = createConnection || ((options, onConnect, onError) => {
    const socket = require("net").createConnection(options);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    return socket;
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    let socket;
    try {
      socket = connect({ host, port }, () => finish(true), () => finish(false));
      socket.setTimeout(timeoutMs, () => finish(false));
    } catch {
      finish(false);
    }
  });
}

async function verifyPortsWithRetry(ports, {
  host = "hosting-php-fpm",
  retries = DEFAULT_VERIFY_RETRIES,
  delayMs = DEFAULT_VERIFY_DELAY_MS,
  createConnection,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  sleep,
} = {}) {
  const doSleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pending = [...new Set((ports || []).map(Number).filter((port) => (
    Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT
  )))];
  if (!pending.length) return [];
  const ready = new Set();
  for (let attempt = 0; attempt < retries && ready.size < pending.length; attempt += 1) {
    for (const port of pending) {
      if (ready.has(port)) continue;
      if (await probePort(port, { host, createConnection, timeoutMs })) ready.add(port);
    }
    if (ready.size < pending.length && attempt < retries - 1) await doSleep(delayMs);
  }
  const unavailable = pending.filter((port) => !ready.has(port));
  if (unavailable.length) {
    const error = new Error(`PHP-FPM pool ports did not accept connections: ${unavailable.join(", ")}`);
    error.statusCode = 502;
    throw error;
  }
  return [...ready].sort((a, b) => a - b);
}

function uniqueTempPath(filePath) {
  return `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
}

function atomicWriteFile(filePath, content, mode = 0o644) {
  const temporary = uniqueTempPath(filePath);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch { /* best-effort temp cleanup */ }
    throw error;
  }
}

class AsyncLock {
  constructor() {
    this._tail = Promise.resolve();
  }
  runExclusive(fn) {
    const result = this._tail.then(() => fn());
    this._tail = result.then(() => {}, () => {});
    return result;
  }
}

class DirectoryLock {
  constructor(lockPath, options = {}) {
    this.lockPath = lockPath;
    this.timeoutMs = Number(options.timeoutMs) || DEFAULT_LOCK_TIMEOUT_MS;
    this.retryMs = Number(options.retryMs) || DEFAULT_LOCK_RETRY_MS;
    this.staleMs = Number(options.staleMs) || DEFAULT_STALE_LOCK_MS;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.local = new AsyncLock();
  }

  async acquire() {
    const deadline = Date.now() + this.timeoutMs;
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    while (true) {
      try {
        fs.mkdirSync(this.lockPath, { mode: 0o700 });
        try {
          fs.writeFileSync(
            path.join(this.lockPath, "owner.json"),
            JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
            { encoding: "utf8", mode: 0o600 },
          );
        } catch (error) {
          fs.rmSync(this.lockPath, { recursive: true, force: true });
          throw error;
        }
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (age > this.staleMs) {
            fs.rmSync(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError.code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() >= deadline) {
          throw Object.assign(new Error("Runtime configuration is busy; try again"), { statusCode: 409 });
        }
        await this.sleep(this.retryMs);
      }
    }
  }

  runExclusive(fn) {
    return this.local.runExclusive(async () => {
      await this.acquire();
      try {
        return await fn();
      } finally {
        fs.rmSync(this.lockPath, { recursive: true, force: true });
      }
    });
  }
}

class RuntimeConfigTransaction {
  constructor(options = {}) {
    this.sitesMapPath = options.sitesMapPath;
    this.poolsPath = options.poolsPath;
    this.backupFile = options.backupFile || null;
    this.validate = options.validate || (async () => {});
    this.reloadNginx = options.reloadNginx || (async () => {});
    this.reloadPhp = options.reloadPhp || (async () => {});
    this.verifyPorts = options.verifyPorts || (async () => []);
    this.atomicWrite = options.atomicWrite || atomicWriteFile;
    this.readFile = options.readFile || ((filePath) => fs.readFileSync(filePath, "utf8"));
    this.lock = options.lock || new AsyncLock();
  }

  async commit({ mapBefore, poolsBefore, mapParsed, poolsParsed }, opts = {}) {
    if (typeof mapBefore !== "string" || typeof poolsBefore !== "string" || !mapParsed || !poolsParsed) {
      throw Object.assign(new Error("Runtime transaction requires proposed map and pool models"), { statusCode: 400 });
    }
    return this.lock.runExclusive(async () => {
      const expected = opts.expectBefore || { map: mapBefore, pools: poolsBefore };
      const currentMap = this.readFile(this.sitesMapPath);
      const currentPools = this.readFile(this.poolsPath);
      if (currentMap !== expected.map || currentPools !== expected.pools) {
        throw Object.assign(
          new Error("Runtime configuration changed after preview; preview again before submitting"),
          { statusCode: 409, executionStarted: false, verificationStatus: "not-required" },
        );
      }
      try {
        validateRuntimeModel(mapParsed, poolsParsed);
      } catch (error) {
        error.executionStarted = false;
        error.verificationStatus = "not-required";
        throw error;
      }
      const renderedMap = renderSitesMap(mapParsed);
      const renderedPools = renderPools(poolsParsed);
      try {
        if (this.backupFile) {
          this.backupFile(this.sitesMapPath, mapBefore);
          this.backupFile(this.poolsPath, poolsBefore);
        }
      } catch (error) {
        error.executionStarted = false;
        error.verificationStatus = "not-required";
        error.rollback = "not-required";
        throw error;
      }
      try {
        this.atomicWrite(this.sitesMapPath, renderedMap);
        this.atomicWrite(this.poolsPath, renderedPools);
      } catch (writeError) {
        let restoreError = "";
        try {
          this.atomicWrite(this.sitesMapPath, mapBefore);
          this.atomicWrite(this.poolsPath, poolsBefore);
        } catch (error) {
          restoreError = String(error?.message || error).slice(0, 300);
        }
        throw Object.assign(writeError, {
          executionStarted: true,
          verificationStatus: "not-required",
          rollback: restoreError ? "failed" : "succeeded",
          rollbackError: restoreError,
          statusCode: 500,
        });
      }
      const portList = collectPoolPorts(poolsParsed);
      let rollback = "not-required";
      try {
        await this.validate();
        await this.reloadPhp();
        await this.reloadNginx();
        if (portList.length) await this.verifyPorts(portList);
      } catch (error) {
        error.executionStarted = true;
        error.verificationStatus = "failed";
        let rollbackOutcome = "succeeded";
        try {
          await this._rollback({ mapBefore, poolsBefore });
        } catch (rollbackError) {
          rollbackOutcome = "failed";
          error.rollbackError = String(rollbackError?.message || rollbackError).slice(0, 300);
        }
        rollback = rollbackOutcome;
        error.rollback = rollbackOutcome;
        if (!error.statusCode) error.statusCode = 502;
        throw error;
      }
      return { applied: true, rollback, ports: portList, verificationStatus: "success" };
    });
  }

  async _rollback({ mapBefore, poolsBefore, expectCurrent = null }) {
    if (expectCurrent) {
      const currentMap = this.readFile(this.sitesMapPath);
      const currentPools = this.readFile(this.poolsPath);
      if (currentMap !== expectCurrent.map || currentPools !== expectCurrent.pools) {
        throw Object.assign(new Error("Runtime configuration changed after activation; automatic rollback was not applied"), {
          statusCode: 409,
        });
      }
    }
    validateRuntimeModel(parseSitesMap(mapBefore), parsePools(poolsBefore));
    this.atomicWrite(this.sitesMapPath, mapBefore);
    this.atomicWrite(this.poolsPath, poolsBefore);
    await this.validate();
    await this.reloadPhp();
    await this.reloadNginx();
    await this.verifyPorts(collectPoolPorts(parsePools(poolsBefore)));
  }

  rollback(snapshot) {
    return this.lock.runExclusive(() => this._rollback(snapshot));
  }
}

module.exports = {
  DEFAULT_PORT_START,
  MAX_PORT,
  MIN_PORT,
  AsyncLock,
  DirectoryLock,
  RuntimeConfigTransaction,
  allocatePort,
  atomicWriteFile,
  collectPoolPorts,
  probePort,
  upstreamPort,
  validateRuntimeModel,
  verifyPortsWithRetry,
};
