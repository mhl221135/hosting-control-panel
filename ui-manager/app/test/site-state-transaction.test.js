const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applySiteStateTransaction } = require("../lib/site-state-transaction");
const { AsyncLock, collectPoolPorts } = require("../lib/runtime-transaction");
const { parsePools } = require("../lib/runtime-config");
const { SiteState } = require("../lib/site-state");

const SAMPLE_MAP = [
  "map $host $site_root {", "  default /var/www/_default;", "  example.com /var/www/example.com;", "}", "",
  "map $host $php_upstream {", "  default hosting-php-fpm:9000;", "  example.com hosting-php-fpm:9001;", "}", "",
  "map $host $canonical_host {", '  default "";', "}", "",
].join("\n");

const POOLS = "[www]\nlisten = 9000\n\n[example_com]\nlisten = 9001\n";

function makeEnv(dir) {
  const paths = {
    sitesMapPath: path.join(dir, "sites.map"),
    poolsPath: path.join(dir, "pools.conf"),
    siteStatePath: path.join(dir, "site-state.json"),
    cacheMapPath: path.join(dir, "cache.map"),
  };
  fs.writeFileSync(paths.sitesMapPath, SAMPLE_MAP, "utf8");
  fs.writeFileSync(paths.poolsPath, POOLS, "utf8");
  fs.writeFileSync(paths.siteStatePath, JSON.stringify({ sites: {"example.com": {} } }, null, 2), "utf8");
  fs.writeFileSync(paths.cacheMapPath, "map $host $site_cache_enabled {\n  default 0;\n  example.com 0;\n}\n\nmap $host $site_cache_version {\n  default 1;\n  example.com 1;\n}\n", "utf8");
  const calls = { validate: 0, reloadPhp: 0, reloadNginx: 0, verified: [] };
  const deps = {
    ...paths,
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
    exists: (filePath) => fs.existsSync(filePath),
    removeFile: (filePath) => fs.rmSync(filePath, { force: true }),
    backupFile: () => {},
    validateConfig: async () => { calls.validate += 1; },
    reloadPhp: async () => { calls.reloadPhp += 1; },
    reloadNginx: async () => { calls.reloadNginx += 1; },
    verifyPorts: async (ports) => { calls.verified.push(ports); },
    collectPorts: (content) => collectPoolPorts(parsePools(content)),
    lock: new AsyncLock(),
  };
  return { deps, calls, paths };
}

test("cache-only fastcgi toggle writes state+cache and reloads nginx only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-cache-"));
  try {
    const { deps, calls, paths } = makeEnv(dir);
    const site = { host: "example.com", port: 9001 };
    const result = await applySiteStateTransaction({
      site,
      opcache: undefined,
      buildState: (snap) => {
        const data = JSON.parse(snap.stateContent);
        data.sites["example.com"] = { ...(data.sites["example.com"] || {}), fastcgiCache: true };
        return data;
      },
      deps,
    });
    assert.equal(result.applied, true);
    assert.equal(result.state.fastcgiCache, true);
    assert.equal(calls.reloadNginx, 1);
    assert.equal(calls.reloadPhp, 0);
    assert.deepEqual(calls.verified, []);
    assert.match(fs.readFileSync(paths.cacheMapPath, "utf8"), /example\.com 1;/);
    const stored = JSON.parse(fs.readFileSync(paths.siteStatePath, "utf8"));
    assert.equal(stored.sites["example.com"].fastcgiCache, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("notes-only change writes state without reloading services", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-notes-"));
  try {
    const { deps, calls, paths } = makeEnv(dir);
    const site = { host: "example.com", port: 9001 };
    const result = await applySiteStateTransaction({
      site,
      opcache: undefined,
      buildState: (snap) => {
        const data = JSON.parse(snap.stateContent);
        data.sites["example.com"] = { ...(data.sites["example.com"] || {}), notes: "hello" };
        return data;
      },
      deps,
    });
    assert.equal(result.state.notes, "hello");
    assert.equal(calls.reloadNginx, 0);
    assert.equal(calls.reloadPhp, 0);
    assert.deepEqual(calls.verified, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opcache change rewrites the pool, snapshots map/pools, and verifies ports", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-op-"));
  try {
    const { deps, calls, paths } = makeEnv(dir);
    const site = { host: "example.com", port: 9001 };
    const result = await applySiteStateTransaction({
      site,
      opcache: false,
      buildState: (snap) => {
        const data = JSON.parse(snap.stateContent);
        data.sites["example.com"] = { ...(data.sites["example.com"] || {}), opcache: false };
        return data;
      },
      deps,
    });
    assert.equal(result.applied, true);
    assert.equal(calls.reloadNginx, 1);
    assert.equal(calls.reloadPhp, 1);
    assert.equal(calls.verified.length, 1);
    assert.match(fs.readFileSync(paths.poolsPath, "utf8"), /opcache\.enable\] = 0/);
    assert.match(fs.readFileSync(paths.sitesMapPath, "utf8"), /example.com hosting-php-fpm:9001/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cache purge increments the version and reloads nginx", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-purge-"));
  try {
    const { deps, calls, paths } = makeEnv(dir);
    const site = { host: "example.com", port: 9001 };
    const result = await applySiteStateTransaction({
      site,
      opcache: undefined,
      buildState: (snap) => {
        const data = JSON.parse(snap.stateContent);
        const current = data.sites["example.com"] || {};
        data.sites["example.com"] = { ...current, cacheVersion: Number(current.cacheVersion || 1) + 1 };
        return data;
      },
      deps,
    });
    assert.equal(result.state.cacheVersion, 2);
    assert.equal(calls.reloadNginx, 1);
    assert.equal(calls.reloadPhp, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validation failure restores all affected files and rolls back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-roll-"));
  try {
    const { deps, paths } = makeEnv(dir);
    deps.validateConfig = (() => { let first = true; return async () => { if (first) { first = false; throw new Error("nginx -t failed"); } }; })();
    const sitesMapBefore = fs.readFileSync(paths.sitesMapPath, "utf8");
    const poolsBefore = fs.readFileSync(paths.poolsPath, "utf8");
    const stateBefore = fs.readFileSync(paths.siteStatePath, "utf8");
    const cacheBefore = fs.readFileSync(paths.cacheMapPath, "utf8");
    const site = { host: "example.com", port: 9001 };
    await assert.rejects(
      applySiteStateTransaction({
        site,
        opcache: false,
        buildState: (snap) => JSON.parse(snap.stateContent),
        deps,
      }),
      (error) => error.message.includes("nginx -t failed") && error.rollback === "succeeded",
    );
    assert.equal(fs.readFileSync(paths.sitesMapPath, "utf8"), sitesMapBefore);
    assert.equal(fs.readFileSync(paths.poolsPath, "utf8"), poolsBefore);
    assert.equal(fs.readFileSync(paths.siteStatePath, "utf8"), stateBefore);
    assert.equal(fs.readFileSync(paths.cacheMapPath, "utf8"), cacheBefore);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback failure is reported distinctly and bounded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-rollfail-"));
  try {
    const { deps } = makeEnv(dir);
    deps.validateConfig = async () => { throw new Error("php-fpm -t failed"); };
    const site = { host: "example.com", port: 9001 };
    await assert.rejects(
      applySiteStateTransaction({
        site,
        opcache: false,
        buildState: (snap) => JSON.parse(snap.stateContent),
        deps,
      }),
      (error) => error.message.includes("php-fpm -t failed")
        && error.rollback === "failed"
        && error.rollbackError && error.rollbackError.length <= 300,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent site-state mutations serialize without deadlock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-concurrent-"));
  try {
    const { deps, paths } = makeEnv(dir);
    const site = { host: "example.com", port: 9001 };
    const run = (enabled) => applySiteStateTransaction({
      site,
      opcache: undefined,
      buildState: (snap) => {
        const data = JSON.parse(snap.stateContent);
        data.sites["example.com"] = { ...(data.sites["example.com"] || {}), fastcgiCache: enabled, notes: `n${enabled}` };
        return data;
      },
      deps,
    });
    const [a, b] = await Promise.all([run(true), run(false)]);
    assert.equal(a.applied, true);
    assert.equal(b.applied, true);
    const final = JSON.parse(fs.readFileSync(paths.siteStatePath, "utf8"));
    assert.ok(["true", "false"].includes(String(final.sites["example.com"].fastcgiCache)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("errors do not echo complete request bodies or configuration", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-nosecret-"));
  try {
    const { deps } = makeEnv(dir);
    deps.validateConfig = async () => { throw new Error("reload failed with Authorization: Bearer abcDEF123456 body"); };
    const site = { host: "example.com", port: 9001 };
    await assert.rejects(
      applySiteStateTransaction({ site, opcache: false, buildState: (snap) => JSON.parse(snap.stateContent), deps }),
      (error) => error.message.includes("reload failed")
        && !error.message.includes(POOLS)
        && !error.rollbackError?.includes("abcDEF123456"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("external Redis failure restores files and invokes compensating rollback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-external-"));
  try {
    const { deps, calls, paths } = makeEnv(dir);
    const stateBefore = fs.readFileSync(paths.siteStatePath, "utf8");
    let rollbackCalls = 0;
    await assert.rejects(
      applySiteStateTransaction({
        site: { host: "example.com", port: 9001 },
        opcache: undefined,
        buildState: (snap) => {
          const data = JSON.parse(snap.stateContent);
          data.sites["example.com"] = { ...data.sites["example.com"], redis: true };
          return data;
        },
        applyExternal: async () => { throw new Error("Redis activation failed"); },
        rollbackExternal: async () => { rollbackCalls += 1; },
        deps,
      }),
      (error) => error.message === "Redis activation failed" && error.rollback === "succeeded",
    );
    assert.equal(rollbackCalls, 1);
    assert.equal(fs.readFileSync(paths.siteStatePath, "utf8"), stateBefore);
    assert.equal(calls.reloadPhp, 0);
    assert.equal(calls.reloadNginx, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failure before the first write requires no rollback or service reload", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-prewrite-"));
  try {
    const { deps, calls } = makeEnv(dir);
    await assert.rejects(
      applySiteStateTransaction({
        site: { host: "example.com", port: 9001 },
        opcache: undefined,
        buildState: () => { throw Object.assign(new Error("invalid state"), { statusCode: 409 }); },
        deps,
      }),
      (error) => error.statusCode === 409 && error.rollback === "not-required",
    );
    assert.equal(calls.validate, 0);
    assert.equal(calls.reloadPhp, 0);
    assert.equal(calls.reloadNginx, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SiteState persists atomically and renders cache map", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-state-"));
  try {
    const cachePath = path.join(dir, "cache.map");
    const store = new SiteState(dir, cachePath);
    store.update("example.com", { fastcgiCache: true, cacheVersion: 2 });
    assert.ok(fs.existsSync(path.join(dir, "site-state.json")));
    assert.match(fs.readFileSync(cachePath, "utf8"), /example\.com 1;/);
    assert.match(fs.readFileSync(cachePath, "utf8"), /example\.com 2;/);
    assert.equal(fs.statSync(path.join(dir, "site-state.json")).mode & 0o777, 0o600);
    const leftover = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftover, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
