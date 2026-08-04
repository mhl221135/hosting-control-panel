const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  AsyncLock,
  RuntimeConfigTransaction,
  allocatePort,
  atomicWriteFile: atomicWriteFileBuiltin,
  collectPoolPorts,
  validateRuntimeModel,
  verifyPortsWithRetry,
} = require("../lib/runtime-transaction");
const { parsePools, parseSitesMap } = require("../lib/runtime-config");
const { MigrationManager } = require("../lib/migration-manager");

const SAMPLE_MAP = [
  "map $host $site_root {", "  default /var/www/_default;", "}", "",
  "map $host $php_upstream {", "  default hosting-php-fpm:9000;", "}", "",
  "map $host $php_enabled {", "  default 1;", "}", "",
  "map $host $canonical_host {", '  default "";', "}", "",
].join("\n");

function setup(dir, { pools = "[www]\nlisten = 9000\n", map = SAMPLE_MAP } = {}) {
  const mapPath = path.join(dir, "sites.map");
  const poolsPath = path.join(dir, "pools.conf");
  fs.writeFileSync(mapPath, map, "utf8");
  fs.writeFileSync(poolsPath, pools, "utf8");
  return { mapPath, poolsPath };
}

function makeTxn(dir, overrides = {}) {
  const { mapPath, poolsPath } = setup(dir);
  const calls = { validate: 0, reloadNginx: 0, reloadPhp: 0, backups: 0, verified: [] };
  const txn = new RuntimeConfigTransaction({
    sitesMapPath: mapPath,
    poolsPath,
    backupFile: () => { calls.backups += 1; },
    validate: async () => { calls.validate += 1; },
    reloadNginx: async () => { calls.reloadNginx += 1; },
    reloadPhp: async () => { calls.reloadPhp += 1; },
    verifyPorts: async (ports) => { calls.verified.push(ports); },
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
    ...overrides,
  });
  const mapBefore = fs.readFileSync(mapPath, "utf8");
  const poolsBefore = fs.readFileSync(poolsPath, "utf8");
  return { txn, mapPath, poolsPath, calls, mapBefore, poolsBefore };
}

function addPool(mapParsed, poolsParsed, name, port) {
  poolsParsed.sections[name] = { listen: String(port), pm: "ondemand", "pm.max_children": "2" };
  poolsParsed.sectionOrder.push(name);
  mapParsed.hosts[name] = {
    host: name, root: `/var/www/${name}`, port, upstream: `hosting-php-fpm:${port}`, phpEnabled: true, canonicalTo: "",
  };
  return { mapParsed, poolsParsed };
}

test("single pool creation commits files atomically and verifies ports", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-single-"));
  try {
    const { txn, mapPath, poolsPath, calls, mapBefore, poolsBefore } = makeTxn(dir);
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    addPool(mapParsed, poolsParsed, "newsite_com", 9001);
    const result = await txn.commit({ mapBefore, poolsBefore, mapParsed, poolsParsed });
    assert.equal(result.applied, true);
    assert.equal(calls.validate, 1);
    assert.equal(calls.reloadNginx, 1);
    assert.equal(calls.reloadPhp, 1);
    assert.deepEqual(calls.verified[0], [9000, 9001]);
    assert.match(fs.readFileSync(poolsPath, "utf8"), /\[newsite_com\]/);
    assert.match(fs.readFileSync(mapPath, "utf8"), /newsite_com/);
    assert.ok(calls.backups >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gap-aware port allocator respects free gaps and ignores malformed ports", () => {
  assert.equal(allocatePort([9000, 9002]), 9001);
  assert.equal(allocatePort([9000, 9001, 9002]), 9003);
  assert.equal(allocatePort([9000, "bogus", -5, 70000, 9001]), 9002);
  assert.equal(allocatePort([], { start: 9500, end: 9502 }), 9500);
  assert.equal(allocatePort([9500], { start: 9500, end: 9502 }), 9501);
  assert.throws(() => allocatePort([9500, 9501, 9502], { start: 9500, end: 9502 }), /No free/);
  assert.throws(() => allocatePort([9000, 9001, 9002], { start: 9000, end: 9002 }), /No free/);
  assert.throws(() => allocatePort([], { start: 93000, end: 94000 }), /range/);
  assert.throws(() => allocatePort([], { start: 9500, end: 9000 }), /range/);
});

test("validation rejects out-of-range, duplicate, missing-pool, and mismatched upstream", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-validate-"));
  try {
    const { mapBefore, poolsBefore } = makeTxn(dir);
    const clonePools = (p) => JSON.parse(JSON.stringify(p));
    const cloneMap = (m) => JSON.parse(JSON.stringify(m));

    const badPort = clonePools(parsePools(poolsBefore));
    badPort.sections.www.listen = "70000";
    assert.throws(() => validateRuntimeModel(parseSitesMap(mapBefore), badPort), /invalid listen port/);

    const dup = clonePools(parsePools(poolsBefore));
    dup.sections.other = { listen: "9000" };
    dup.sectionOrder.push("other");
    assert.throws(() => validateRuntimeModel(parseSitesMap(mapBefore), dup), /Duplicate listen port/);

    const missingPool = cloneMap(parseSitesMap(mapBefore));
    missingPool.hosts.ghost = { host: "ghost", root: "/srv/ghost", port: 9001, upstream: "hosting-php-fpm:9001", phpEnabled: true, canonicalTo: "" };
    assert.throws(() => validateRuntimeModel(missingPool, parsePools(poolsBefore)), /missing pool port/);

    const mismatch = cloneMap(parseSitesMap(mapBefore));
    mismatch.hosts.ghost = { host: "ghost", root: "/srv/ghost", port: 9000, upstream: "hosting-php-fpm:9999", phpEnabled: true, canonicalTo: "" };
    assert.throws(() => validateRuntimeModel(mismatch, parsePools(poolsBefore)), /disagrees/);

    const dupSection = clonePools(parsePools(poolsBefore));
    dupSection.sectionOrder = ["www", "www"];
    assert.throws(() => validateRuntimeModel(parseSitesMap(mapBefore), dupSection), /Duplicate pool section/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validation failure before reload leaves files unchanged and reports rollback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-valfail-"));
  try {
    const { txn, mapPath, mapBefore, poolsBefore, calls } = makeTxn(dir);
    const basePools = parsePools(poolsBefore);
    basePools.sections.other = { listen: "9000" };
    basePools.sectionOrder.push("other");
    await assert.rejects(
      txn.commit({
        mapBefore,
        poolsBefore,
        mapParsed: parseSitesMap(fs.readFileSync(mapPath, "utf8")),
        poolsParsed: basePools,
      }),
      /Duplicate listen port/,
    );
    assert.equal(calls.validate, 0);
    assert.equal(fs.readFileSync(mapPath, "utf8"), fs.readFileSync(path.join(dir, "sites.map"), "utf8"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("php-fpm reload failure triggers verified rollback that restores files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-reloadfail-"));
  try {
    const { txn, mapPath, poolsPath, mapBefore, poolsBefore } = makeTxn(dir, {
      reloadPhp: (() => { let first = true; return async () => { if (first) { first = false; throw new Error("kill -USR2 failed"); } }; })(),
    });
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    addPool(mapParsed, poolsParsed, "newsite_com", 9001);
    await assert.rejects(
      txn.commit({ mapBefore, poolsBefore, mapParsed, poolsParsed }),
      (error) => error.message.includes("kill -USR2 failed") && error.rollback === "succeeded",
    );
    assert.equal(fs.readFileSync(poolsPath, "utf8"), poolsBefore);
    assert.equal(fs.readFileSync(mapPath, "utf8"), mapBefore);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nginx reload failure triggers verified rollback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-nginxfail-"));
  try {
    const { txn, mapPath, poolsPath, mapBefore, poolsBefore } = makeTxn(dir, {
      reloadNginx: (() => { let first = true; return async () => { if (first) { first = false; throw new Error("nginx reload failed"); } }; })(),
    });
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    addPool(mapParsed, poolsParsed, "newsite_com", 9001);
    await assert.rejects(
      txn.commit({ mapBefore, poolsBefore, mapParsed, poolsParsed }),
      (error) => error.message.includes("nginx reload failed") && error.rollback === "succeeded",
    );
    assert.equal(fs.readFileSync(poolsPath, "utf8"), poolsBefore);
    assert.equal(fs.readFileSync(mapPath, "utf8"), mapBefore);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("port never becoming ready fails with rollback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-portfail-"));
  try {
    const { txn, mapPath, poolsPath, mapBefore, poolsBefore } = makeTxn(dir, {
      verifyPorts: (() => { let first = true; return async () => { if (first) { first = false; throw new Error("port 9001 did not accept connections"); } return [9000]; }; })(),
    });
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    addPool(mapParsed, poolsParsed, "newsite_com", 9001);
    await assert.rejects(
      txn.commit({ mapBefore, poolsBefore, mapParsed, poolsParsed }),
      (error) => error.message.includes("did not accept connections") && error.rollback === "succeeded",
    );
    assert.equal(fs.readFileSync(poolsPath, "utf8"), poolsBefore);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback verification failure is reported as rollback failed and bounded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-rollfail-"));
  try {
    const { txn, mapBefore, poolsBefore } = makeTxn(dir, {
      validate: (() => {
        let first = true;
        return async () => {
          if (first) { first = false; throw new Error("php-fpm -t failed"); }
          throw new Error("restore validation also failed");
        };
      })(),
    });
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    addPool(mapParsed, poolsParsed, "newsite_com", 9001);
    await assert.rejects(
      txn.commit({ mapBefore, poolsBefore, mapParsed, poolsParsed }),
      (error) => error.message.includes("php-fpm -t failed")
        && error.rollback === "failed"
        && error.rollbackError && error.rollbackError.length <= 300
        && !error.rollbackError.includes(poolsBefore.slice(0, 40)),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stale source state is rejected before committing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-stale-"));
  try {
    const { txn, poolsPath, mapBefore, poolsBefore } = makeTxn(dir);
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    addPool(mapParsed, poolsParsed, "newsite_com", 9001);
    fs.writeFileSync(poolsPath, "[www]\nlisten = 9000\n\n[other]\nlisten = 9009\n", "utf8");
    await assert.rejects(
      txn.commit({ mapBefore, poolsBefore, mapParsed, poolsParsed }, {
        expectBefore: { map: mapBefore, pools: poolsBefore },
      }),
      /changed after preview/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no success before port verification completes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-verifywait-"));
  try {
    let resolveVerify;
    const { txn, mapBefore, poolsBefore } = makeTxn(dir, {
      verifyPorts: async () => new Promise((resolve) => { resolveVerify = resolve; }),
    });
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    addPool(mapParsed, poolsParsed, "newsite_com", 9001);
    const pending = txn.commit({ mapBefore, poolsBefore, mapParsed, poolsParsed });
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(settled, false, "must not resolve before verification completes");
    resolveVerify([9000, 9001]);
    const result = await pending;
    assert.equal(result.applied, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delayed port readiness succeeds within retry bounds", async () => {
  function fakeConnect(attemptsUntilOk) {
    let count = 0;
    return (options, onConnect, onError) => {
      const socket = { destroyed: false };
      socket.setTimeout = () => {};
      socket.destroy = () => { socket.destroyed = true; };
      setImmediate(() => {
        count += 1;
        if (count >= attemptsUntilOk) onConnect(); else onError(new Error("refused"));
      });
      return socket;
    };
  }
  const ports = await verifyPortsWithRetry([9001, 9002], {
    retries: 5,
    delayMs: 0,
    createConnection: fakeConnect(3),
    sleep: async () => {},
  });
  assert.deepEqual(ports, [9001, 9002].sort((a, b) => a - b));
});

test("port never becoming ready exceeds retry bounds and rejects", async () => {
  function alwaysFail(options, onConnect, onError) {
    const socket = { destroyed: false };
    socket.setTimeout = () => {};
    socket.destroy = () => { socket.destroyed = true; };
    setImmediate(() => onError(new Error("refused")));
    return socket;
  }
  await assert.rejects(
    verifyPortsWithRetry([9001], { retries: 3, delayMs: 0, createConnection: alwaysFail, sleep: async () => {} }),
    /did not accept connections/,
  );
});

test("collectPoolPorts returns valid unique ports only", () => {
  const parsed = parsePools("[www]\nlisten = 9000\n\n[a]\nlisten = 9000\n\n[b]\nlisten = 99999\n\n[c]\nlisten = 9002\n");
  assert.deepEqual(collectPoolPorts(parsed), [9000, 9002]);
});

test("AsyncLock serializes mutations", async () => {
  const lock = new AsyncLock();
  const order = [];
  await Promise.all([
    lock.runExclusive(async () => { order.push("a"); await new Promise((r) => setTimeout(r, 10)); order.push("a2"); }),
    lock.runExclusive(async () => { order.push("b"); }),
  ]);
  assert.deepEqual(order, ["a", "a2", "b"]);
});

test("MigrationManager configureRuntime uses shared allocator and returns model for transaction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-cfgruntime-"));
  try {
    const mapPath = path.join(dir, "sites.map");
    const poolsPath = path.join(dir, "pools.conf");
    fs.writeFileSync(mapPath, SAMPLE_MAP, "utf8");
    fs.writeFileSync(poolsPath, "[www]\nlisten = 9000\n\n[gap_pool]\nlisten = 9002\n", "utf8");
    fs.mkdirSync(path.join(dir, "websites"), { recursive: true });
    const manager = new MigrationManager({
      dataDir: dir,
      exportsRoot: path.join(dir, "exports"),
      importsRoot: path.join(dir, "imports"),
      websitesRoot: path.join(dir, "websites"),
      sitesMapPath: mapPath,
      poolsPath,
      siteState: { get: () => ({}) },
      runtimeTransaction: { commit: async () => ({ applied: true }) },
    });
    const result = manager.configureRuntime([{
      domain: "two.example.com",
      aliases: [],
      canonicalAliases: [],
      websitePath: "two.example.com",
      siteType: "wordpress",
      poolTier: "medium",
      state: { siteType: "wordpress", opcache: true },
    }]);
    assert.equal(result.committed, true);
    assert.equal(result.hasPhp, true);
    assert.equal(result.configured[0].port, 9001, "fills the gap rather than max+1");
    assert.equal(result.mapParsed.hosts["two.example.com"].upstream, "hosting-php-fpm:9001");
    assert.equal(result.poolsParsed.sections.two_example_com.listen, "9001");
    assert.doesNotMatch(fs.readFileSync(poolsPath, "utf8"), /two_example_com/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transaction never embeds full configuration contents in results or errors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-nosecret-"));
  try {
    const token = "SUPER_SECRET_TOKEN_12345";
    const { txn, mapBefore, poolsBefore } = makeTxn(dir, {
      validate: (() => { let first = true; return async () => { if (first) { first = false; throw new Error(`validation ${token}`); } }; })(),
    });
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    addPool(mapParsed, poolsParsed, "newsite_com", 9001);
    await assert.rejects(
      txn.commit({ mapBefore, poolsBefore, mapParsed, poolsParsed }),
      (error) => error.message.includes("validation")
        && error.rollback === "succeeded"
        && !error.message.includes(poolsBefore)
        && !JSON.stringify(error).includes("super secret"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("partial write failure restores both files and reports rollback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-partialwrite-"));
  try {
    const { txn, mapPath, poolsPath, mapBefore, poolsBefore } = makeTxn(dir, {
      atomicWrite: (() => {
        let failed = false;
        return (filePath, content) => {
          if (filePath === poolsPath && !failed) {
            failed = true;
            throw Object.assign(new Error("disk full"), { statusCode: 500 });
          }
          atomicWriteFileBuiltin(filePath, content);
        };
      })(),
    });
    const mapParsed = parseSitesMap(mapBefore);
    const poolsParsed = parsePools(poolsBefore);
    addPool(mapParsed, poolsParsed, "newsite_com", 9001);
    await assert.rejects(
      txn.commit({ mapBefore, poolsBefore, mapParsed, poolsParsed }),
      (error) => error.message.includes("disk full") && error.rollback === "succeeded",
    );
    assert.equal(fs.readFileSync(mapPath, "utf8"), mapBefore);
    assert.equal(fs.readFileSync(poolsPath, "utf8"), poolsBefore);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failed atomic write cleans up its temporary file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txn-tmpclean-"));
  try {
    const blocker = path.join(dir, "blocked.conf");
    fs.mkdirSync(blocker);
    assert.throws(() => atomicWriteFileBuiltin(blocker, "x"));
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
