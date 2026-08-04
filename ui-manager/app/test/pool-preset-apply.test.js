const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  applyPlan,
  buildApplyPlan,
  detectTier,
  normalizeTier,
  previewApply,
} = require("../lib/pool-preset-apply");

const PRESETS = {
  low: {
    pm: "ondemand",
    max_children: "2",
    start_servers: "1",
    min_spare_servers: "1",
    max_spare_servers: "2",
    process_idle_timeout: "20s",
    request_terminate_timeout: "120s",
    max_requests: "400",
  },
  medium: {
    pm: "ondemand",
    max_children: "6",
    start_servers: "1",
    min_spare_servers: "1",
    max_spare_servers: "2",
    process_idle_timeout: "30s",
    request_terminate_timeout: "120s",
    max_requests: "500",
  },
  high: {
    pm: "dynamic",
    max_children: "10",
    start_servers: "2",
    min_spare_servers: "2",
    max_spare_servers: "4",
    process_idle_timeout: "45s",
    request_terminate_timeout: "120s",
    max_requests: "700",
  },
};

function poolContent(name, settings) {
  const lines = [`[${name}]`];
  for (const [key, value] of Object.entries(settings)) lines.push(`${key} = ${value}`);
  return `${lines.join("\n")}\n`;
}

function mediumPool(name, port) {
  return poolContent(name, {
    user: "www-data",
    group: "www-data",
    listen: String(port),
    pm: "ondemand",
    "pm.max_children": "6",
    "pm.start_servers": "1",
    "pm.min_spare_servers": "1",
    "pm.max_spare_servers": "2",
    "pm.process_idle_timeout": "30s",
    "pm.max_requests": "500",
    request_terminate_timeout: "120s",
    clear_env: "no",
    catch_workers_output: "yes",
  });
}

function customPool(name, port) {
  return poolContent(name, {
    user: "www-data",
    group: "www-data",
    listen: String(port),
    pm: "static",
    "pm.max_children": "4",
    "pm.start_servers": "4",
    "pm.min_spare_servers": "4",
    "pm.max_spare_servers": "4",
    "pm.process_idle_timeout": "60s",
    "pm.max_requests": "1000",
    request_terminate_timeout: "300s",
    clear_env: "no",
    catch_workers_output: "yes",
  });
}

function dotPool(name, port) {
  return poolContent(name, {
    user: "www-data",
    group: "www-data",
    listen: String(port),
    pm: "ondemand",
    "pm.max_children": "6",
    "pm.start_servers": "1",
    "pm.min_spare_servers": "1",
    "pm.max_spare_servers": "2",
    "pm.process_idle_timeout": "30s",
    "pm.max_requests": "500",
    request_terminate_timeout: "120s",
    clear_env: "no",
    catch_workers_output: "yes",
  });
}

test("preview lists only pools that would change and preserves custom pools", () => {
  const content = mediumPool("example_com", 9001) + customPool("custom_pool", 9002);
  const proposed = { ...PRESETS, medium: { ...PRESETS.medium, max_children: "8" } };
  const { affected, customPools } = previewApply(proposed, content, PRESETS);
  assert.equal(affected.length, 1);
  assert.equal(affected[0].name, "example_com");
  assert.ok(affected[0].changes.some((change) => change.field === "pm.max_children" && change.from === "6" && change.to === "8"));
  assert.equal(customPools.length, 1);
  assert.equal(customPools[0].name, "custom_pool");
});

test("preview preserves exact pool names containing dots", () => {
  const content = dotPool("viniah.co", 9001);
  const proposed = { ...PRESETS, medium: { ...PRESETS.medium, max_children: "8" } };
  const { affected } = previewApply(proposed, content, PRESETS);
  assert.equal(affected.length, 1);
  assert.equal(affected[0].name, "viniah.co");
});

test("request-timeout-only drift is classified as custom", () => {
  const content = mediumPool("timeout_drift", 9001).replace(
    "request_terminate_timeout = 120s",
    "request_terminate_timeout = 90s",
  );
  const proposed = { ...PRESETS, medium: { ...PRESETS.medium, max_children: "8" } };
  const { affected, customPools } = previewApply(proposed, content, PRESETS);
  assert.deepEqual(affected, []);
  assert.deepEqual(customPools, [{ name: "timeout_drift", tier: "custom" }]);
});

test("buildApplyPlan rejects selecting custom or unaffected pools", () => {
  const content = mediumPool("example_com", 9001) + customPool("custom_pool", 9002);
  const proposed = { ...PRESETS, medium: { ...PRESETS.medium, max_children: "8" } };
  assert.throws(
    () => buildApplyPlan(proposed, content, PRESETS, ["custom_pool"]),
    /not affected/,
  );
  assert.throws(
    () => buildApplyPlan(proposed, content, PRESETS, ["missing_pool"]),
    /not affected/,
  );
});

test("buildApplyPlan allows selective application of affected pools", () => {
  const content = mediumPool("example_com", 9001) + mediumPool("shop_com", 9002);
  const proposed = { ...PRESETS, medium: { ...PRESETS.medium, max_children: "8" } };
  const plan = buildApplyPlan(proposed, content, PRESETS, ["example_com"]);
  assert.deepEqual(plan.selected.map((pool) => pool.name), ["example_com"]);
  assert.equal(plan.affected.length, 2);
});

test("applyPlan backs up, validates, reloads, verifies ports, and reports applied pools", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-apply-"));
  const poolsPath = path.join(directory, "pools.conf");
  const presetsPath = path.join(directory, "pool-presets.json");
  const sitesMapPath = path.join(directory, "sites.map");
  const poolsBefore = mediumPool("example_com", 9001);
  const presetsBefore = JSON.stringify(PRESETS, null, 2);
  const sitesMapBefore = "map $host $site_root { default /var/www/_default; }\n";
  fs.writeFileSync(poolsPath, poolsBefore, "utf8");
  fs.writeFileSync(presetsPath, presetsBefore, "utf8");
  fs.writeFileSync(sitesMapPath, sitesMapBefore, "utf8");

  const proposed = { ...PRESETS, medium: { ...PRESETS.medium, max_children: "8" } };
  const plan = buildApplyPlan(proposed, poolsBefore, PRESETS, ["example_com"]);
  const calls = { validate: 0, reload: 0, verify: 0, backups: 0 };
  const result = await applyPlan({ ...plan, payload: proposed }, {
    poolsPath,
    presetsPath,
    sitesMapPath,
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
    writeFile: (filePath, content) => fs.writeFileSync(filePath, content, "utf8"),
    renameFile: (from, to) => fs.renameSync(from, to),
    backupFile: (filePath, content) => {
      calls.backups += 1;
      fs.writeFileSync(`${filePath}.${calls.backups}.bak`, content, "utf8");
    },
    validateConfig: async () => { calls.validate += 1; },
    reloadPhp: async () => { calls.reload += 1; },
    verifyPorts: async () => { calls.verify += 1; },
  });

  assert.deepEqual(result.applied, ["example_com"]);
  assert.equal(calls.validate, 1);
  assert.equal(calls.reload, 1);
  assert.equal(calls.verify, 1);
  assert.equal(calls.backups, 3);
  const poolsAfter = fs.readFileSync(poolsPath, "utf8");
  assert.match(poolsAfter, /pm\.max_children = 8/);
  const presetsAfter = JSON.parse(fs.readFileSync(presetsPath, "utf8"));
  assert.equal(presetsAfter.medium.max_children, "8");
  assert.ok(fs.existsSync(`${presetsPath}.1.bak`));
  assert.ok(fs.existsSync(`${poolsPath}.2.bak`));
  assert.ok(fs.existsSync(`${sitesMapPath}.3.bak`));
});

test("applyPlan rolls back when validation fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-apply-rollback-"));
  const poolsPath = path.join(directory, "pools.conf");
  const presetsPath = path.join(directory, "pool-presets.json");
  const sitesMapPath = path.join(directory, "sites.map");
  const poolsBefore = mediumPool("example_com", 9001);
  const presetsBefore = JSON.stringify(PRESETS, null, 2);
  const sitesMapBefore = "map $host $site_root { default /var/www/_default; }\n";
  fs.writeFileSync(poolsPath, poolsBefore, "utf8");
  fs.writeFileSync(presetsPath, presetsBefore, "utf8");
  fs.writeFileSync(sitesMapPath, sitesMapBefore, "utf8");

  const proposed = { ...PRESETS, medium: { ...PRESETS.medium, max_children: "8" } };
  const plan = buildApplyPlan(proposed, poolsBefore, PRESETS, ["example_com"]);
  await assert.rejects(
    applyPlan({ ...plan, payload: proposed }, {
      poolsPath,
      presetsPath,
      sitesMapPath,
      readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
      writeFile: (filePath, content) => fs.writeFileSync(filePath, content, "utf8"),
      renameFile: (from, to) => fs.renameSync(from, to),
      backupFile: (filePath, content) => fs.writeFileSync(`${filePath}.bak`, content, "utf8"),
      validateConfig: async () => { throw new Error("php-fpm -t failed"); },
      reloadPhp: async () => {},
      verifyPorts: async () => {},
    }),
    (error) => {
      assert.match(error.message, /rolled back/);
      assert.equal(error.executionStarted, true);
      assert.equal(error.rollbackStatus, "succeeded");
      return true;
    },
  );
  assert.equal(fs.readFileSync(poolsPath, "utf8"), poolsBefore);
  assert.equal(fs.readFileSync(presetsPath, "utf8"), presetsBefore);
  assert.equal(fs.readFileSync(sitesMapPath, "utf8"), sitesMapBefore);
});

test("applyPlan rolls back a partial atomic-write failure", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-apply-write-failure-"));
  const poolsPath = path.join(directory, "pools.conf");
  const presetsPath = path.join(directory, "pool-presets.json");
  const sitesMapPath = path.join(directory, "sites.map");
  const poolsBefore = mediumPool("example_com", 9001);
  const presetsBefore = JSON.stringify(PRESETS, null, 2);
  fs.writeFileSync(poolsPath, poolsBefore, "utf8");
  fs.writeFileSync(presetsPath, presetsBefore, "utf8");
  fs.writeFileSync(sitesMapPath, "sites map\n", "utf8");
  const proposed = { ...PRESETS, medium: { ...PRESETS.medium, max_children: "8" } };
  const plan = buildApplyPlan(proposed, poolsBefore, PRESETS, ["example_com"]);
  let failedOnce = false;
  await assert.rejects(
    applyPlan({ ...plan, payload: proposed }, {
      poolsPath,
      presetsPath,
      sitesMapPath,
      readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
      writeFile: (filePath, content) => {
        if (filePath.startsWith(`${poolsPath}.`) && !filePath.includes("rollback") && !failedOnce) {
          failedOnce = true;
          throw new Error("disk write failed");
        }
        fs.writeFileSync(filePath, content, "utf8");
      },
      renameFile: (from, to) => fs.renameSync(from, to),
      backupFile: () => {},
      validateConfig: async () => {},
      reloadPhp: async () => {},
      verifyPorts: async () => {},
    }),
    /rolled back.*disk write failed/,
  );
  assert.equal(fs.readFileSync(poolsPath, "utf8"), poolsBefore);
  assert.equal(fs.readFileSync(presetsPath, "utf8"), presetsBefore);
});

test("applyPlan reports a failed rollback", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-apply-rollback-failure-"));
  const poolsPath = path.join(directory, "pools.conf");
  const presetsPath = path.join(directory, "pool-presets.json");
  const sitesMapPath = path.join(directory, "sites.map");
  const poolsBefore = mediumPool("example_com", 9001);
  fs.writeFileSync(poolsPath, poolsBefore, "utf8");
  fs.writeFileSync(presetsPath, JSON.stringify(PRESETS), "utf8");
  fs.writeFileSync(sitesMapPath, "sites map\n", "utf8");
  const proposed = { ...PRESETS, medium: { ...PRESETS.medium, max_children: "8" } };
  const plan = buildApplyPlan(proposed, poolsBefore, PRESETS, ["example_com"]);

  await assert.rejects(
    applyPlan({ ...plan, payload: proposed }, {
      poolsPath,
      presetsPath,
      sitesMapPath,
      readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
      writeFile: (filePath, content) => {
        if (filePath.includes("rollback")) throw new Error("rollback disk failure");
        fs.writeFileSync(filePath, content, "utf8");
      },
      renameFile: (from, to) => fs.renameSync(from, to),
      backupFile: () => {},
      validateConfig: async () => { throw new Error("php-fpm -t failed"); },
      reloadPhp: async () => {},
      verifyPorts: async () => {},
    }),
    (error) => {
      assert.match(error.message, /rollback failed/);
      assert.equal(error.executionStarted, true);
      assert.equal(error.rollbackStatus, "failed");
      assert.equal(error.rollbackError, "rollback disk failure");
      return true;
    },
  );
});

test("applyPlan reports backup failure without claiming a rollback", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-apply-backup-failure-"));
  const poolsPath = path.join(directory, "pools.conf");
  const presetsPath = path.join(directory, "pool-presets.json");
  const sitesMapPath = path.join(directory, "sites.map");
  const poolsBefore = mediumPool("example_com", 9001);
  fs.writeFileSync(poolsPath, poolsBefore, "utf8");
  fs.writeFileSync(presetsPath, JSON.stringify(PRESETS), "utf8");
  fs.writeFileSync(sitesMapPath, "sites map\n", "utf8");
  const proposed = { ...PRESETS, medium: { ...PRESETS.medium, max_children: "8" } };
  const plan = buildApplyPlan(proposed, poolsBefore, PRESETS, ["example_com"]);

  await assert.rejects(
    applyPlan({ ...plan, payload: proposed }, {
      poolsPath,
      presetsPath,
      sitesMapPath,
      readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
      writeFile: (filePath, content) => fs.writeFileSync(filePath, content, "utf8"),
      renameFile: (from, to) => fs.renameSync(from, to),
      backupFile: () => { throw new Error("backup disk full"); },
      validateConfig: async () => {},
      reloadPhp: async () => {},
      verifyPorts: async () => {},
    }),
    (error) => {
      assert.match(error.message, /no configuration was changed/);
      assert.equal(error.executionStarted, true);
      assert.equal(error.rollbackStatus, "not-required");
      return true;
    },
  );
  assert.equal(fs.readFileSync(poolsPath, "utf8"), poolsBefore);
});

test("applyPlan rolls back when reload or port verification fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-apply-reload-"));
  const poolsPath = path.join(directory, "pools.conf");
  const presetsPath = path.join(directory, "pool-presets.json");
  const sitesMapPath = path.join(directory, "sites.map");
  const poolsBefore = mediumPool("example_com", 9001);
  const presetsBefore = JSON.stringify(PRESETS, null, 2);
  const sitesMapBefore = "map $host $site_root { default /var/www/_default; }\n";
  fs.writeFileSync(poolsPath, poolsBefore, "utf8");
  fs.writeFileSync(presetsPath, presetsBefore, "utf8");
  fs.writeFileSync(sitesMapPath, sitesMapBefore, "utf8");

  const proposed = { ...PRESETS, medium: { ...PRESETS.medium, max_children: "8" } };
  const plan = buildApplyPlan(proposed, poolsBefore, PRESETS, ["example_com"]);
  await assert.rejects(
    applyPlan({ ...plan, payload: proposed }, {
      poolsPath,
      presetsPath,
      sitesMapPath,
      readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
      writeFile: (filePath, content) => fs.writeFileSync(filePath, content, "utf8"),
      renameFile: (from, to) => fs.renameSync(from, to),
      backupFile: (filePath, content) => fs.writeFileSync(`${filePath}.bak`, content, "utf8"),
      validateConfig: async () => {},
      reloadPhp: async () => {},
      verifyPorts: async () => {
        fs.writeFileSync(sitesMapPath, "concurrent sites map update\n", "utf8");
        throw new Error("port 9001 did not accept connections");
      },
    }),
    /rolled back/,
  );
  assert.equal(fs.readFileSync(poolsPath, "utf8"), poolsBefore);
  assert.equal(fs.readFileSync(presetsPath, "utf8"), presetsBefore);
  assert.equal(fs.readFileSync(sitesMapPath, "utf8"), "concurrent sites map update\n");
});

test("applyPlan rejects pool state changed after preview", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-apply-stale-"));
  const poolsPath = path.join(directory, "pools.conf");
  const presetsPath = path.join(directory, "pool-presets.json");
  const sitesMapPath = path.join(directory, "sites.map");
  const poolsBefore = mediumPool("example_com", 9001);
  fs.writeFileSync(poolsPath, poolsBefore, "utf8");
  fs.writeFileSync(presetsPath, JSON.stringify(PRESETS), "utf8");
  fs.writeFileSync(sitesMapPath, "sites map\n", "utf8");
  const proposed = { ...PRESETS, medium: { ...PRESETS.medium, max_children: "8" } };
  const plan = buildApplyPlan(proposed, poolsBefore, PRESETS, ["example_com"]);
  fs.writeFileSync(poolsPath, poolsBefore.replace("pm.max_children = 6", "pm.max_children = 7"), "utf8");
  let backups = 0;
  await assert.rejects(
    applyPlan({ ...plan, payload: proposed }, {
      poolsPath,
      presetsPath,
      sitesMapPath,
      readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
      writeFile: (filePath, content) => fs.writeFileSync(filePath, content, "utf8"),
      renameFile: (from, to) => fs.renameSync(from, to),
      backupFile: () => { backups += 1; },
      validateConfig: async () => {},
      reloadPhp: async () => {},
      verifyPorts: async () => {},
    }),
    (error) => {
      assert.match(error.message, /changed after preview/);
      assert.notEqual(error.executionStarted, true);
      assert.equal(error.rollbackStatus, undefined);
      return true;
    },
  );
  assert.equal(backups, 0);
});

test("applyPlan rejects an empty selection", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-apply-empty-"));
  const poolsPath = path.join(directory, "pools.conf");
  const presetsPath = path.join(directory, "pool-presets.json");
  const sitesMapPath = path.join(directory, "sites.map");
  fs.writeFileSync(poolsPath, mediumPool("example_com", 9001), "utf8");
  fs.writeFileSync(presetsPath, JSON.stringify(PRESETS), "utf8");
  fs.writeFileSync(sitesMapPath, "map $host $site_root { default /var/www/_default; }\n", "utf8");
  await assert.rejects(
    applyPlan({ selected: [], payload: PRESETS }, {
      poolsPath,
      presetsPath,
      sitesMapPath,
      readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
      writeFile: (filePath, content) => fs.writeFileSync(filePath, content, "utf8"),
      renameFile: (from, to) => fs.renameSync(from, to),
      backupFile: () => {},
      validateConfig: async () => {},
      reloadPhp: async () => {},
      verifyPorts: async () => {},
    }),
    /No pools selected/,
  );
});

test("detectTier and normalizeTier behave correctly", () => {
  assert.equal(normalizeTier("medium", PRESETS), "medium");
  assert.equal(normalizeTier("MEDIUM", PRESETS), "medium");
  assert.equal(normalizeTier("unknown", PRESETS), "");
  assert.equal(detectTier(mediumPool("x", 9001).split("\n").slice(1).reduce((acc, line) => {
    const [key, value] = line.split(" = ");
    if (key) acc[key] = value;
    return acc;
  }, {}), PRESETS), "medium");
  assert.equal(detectTier(customPool("x", 9001).split("\n").slice(1).reduce((acc, line) => {
    const [key, value] = line.split(" = ");
    if (key) acc[key] = value;
    return acc;
  }, {}), PRESETS), "custom");
});
