const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parsePools, parseSitesMap, renderSitesMap } = require("../lib/runtime-config");
const { ensureStaticPhpGate, migrateStaticRoutes, activateStaticMigration } = require("../lib/static-route-migration");

const LEGACY_MAP = [
  "map $host $site_root {",
  "  default /var/www/_default;",
  "  static.example /var/www/static.example;",
  "  www.static.example /var/www/static.example;",
  "  dynamic.example /var/www/dynamic.example;",
  "}",
  "",
  "map $host $php_upstream {",
  "  default hosting-php-fpm:9000;",
  "  static.example hosting-php-fpm:9001;",
  "  www.static.example hosting-php-fpm:9001;",
  "  dynamic.example hosting-php-fpm:9002;",
  "}",
  "",
  "map $host $canonical_host {",
  '  default "";',
  "  www.static.example static.example;",
  "}",
  "",
].join("\n");

const POOLS = [
  "[www]",
  "listen = 9000",
  "",
  "[static_example]",
  "listen = 9001",
  "",
  "[dynamic_example]",
  "listen = 9002",
  "",
].join("\n");

const NGINX = [
  "server {",
  "    location ~ \\.php$ {",
  "        try_files $uri =404;",
  "    }",
  "}",
  "",
].join("\n");

test("legacy maps default existing routes to PHP and gain an explicit capability map", () => {
  const parsed = parseSitesMap(LEGACY_MAP);
  assert.equal(parsed.hosts["static.example"].phpEnabled, true);
  const rendered = renderSitesMap(parsed);
  assert.match(rendered, /map \$host \$site_php_enabled/);
  assert.equal(parseSitesMap(rendered).hosts["dynamic.example"].phpEnabled, true);
});

test("converts static aliases, removes only their unused pool, and adds the nginx gate", () => {
  const result = migrateStaticRoutes({
    mapContent: LEGACY_MAP,
    poolsContent: POOLS,
    nginxContent: NGINX,
    siteState: { sites: { "static.example": { siteType: "static" }, "dynamic.example": { siteType: "wordpress" } } },
  });
  const map = parseSitesMap(result.mapContent);
  const pools = parsePools(result.poolsContent);
  assert.equal(map.hosts["static.example"].phpEnabled, false);
  assert.equal(map.hosts["static.example"].port, null);
  assert.equal(map.hosts["www.static.example"].phpEnabled, false);
  assert.equal(map.hosts["dynamic.example"].phpEnabled, true);
  assert.equal(pools.sections.static_example, undefined);
  assert.equal(pools.sections.dynamic_example.listen, "9002");
  assert.deepEqual(result.removedPools, ["static_example"]);
  assert.match(result.nginxContent, /if \(\$site_php_enabled = 0\) \{ return 404; \}/);
  assert.equal(ensureStaticPhpGate(result.nginxContent), result.nginxContent);
});

test("refuses to disable PHP when a non-static primary shares the document root", () => {
  assert.throws(() => migrateStaticRoutes({
    mapContent: LEGACY_MAP.replace("/var/www/dynamic.example", "/var/www/static.example"),
    poolsContent: POOLS,
    nginxContent: NGINX,
    siteState: { sites: { "static.example": { siteType: "static" }, "dynamic.example": { siteType: "wordpress" } } },
  }), /shares its document root/);
});

test("reclassifies a legacy PHP site and recovers its removed pool", () => {
  const isolated = migrateStaticRoutes({
    mapContent: LEGACY_MAP,
    poolsContent: POOLS,
    nginxContent: NGINX,
    siteState: { sites: { "static.example": { siteType: "static" }, "dynamic.example": { siteType: "wordpress" } } },
  });
  const recovered = migrateStaticRoutes({
    mapContent: isolated.mapContent,
    poolsContent: isolated.poolsContent,
    nginxContent: isolated.nginxContent,
    siteState: isolated.siteState,
    legacyPhpDomains: ["static.example"],
  });
  const map = parseSitesMap(recovered.mapContent);
  const pools = parsePools(recovered.poolsContent);
  assert.equal(recovered.siteState.sites["static.example"].siteType, "generic-php");
  assert.equal(map.hosts["static.example"].phpEnabled, true);
  assert.equal(map.hosts["www.static.example"].phpEnabled, true);
  assert.ok(map.hosts["static.example"].port);
  assert.equal(pools.sections.static_example.listen, String(map.hosts["static.example"].port));
  assert.deepEqual(recovered.reclassified, ["static.example"]);
  assert.deepEqual(recovered.recoveredPools, ["static_example"]);
});

function makeActivationDeps(dir, overrides = {}) {
  const paths = {
    sitesMapPath: path.join(dir, "sites.map"),
    poolsPath: path.join(dir, "pools.conf"),
    nginxDefaultPath: path.join(dir, "default.conf"),
    statePath: path.join(dir, "site-state.json"),
  };
  const calls = { validate: 0, reloadPhp: 0, reloadNginx: 0, verified: [] };
  const deps = {
    ...paths,
    atomicWrite: (filePath, content, mode) => {
      const tmp = `${filePath}.${process.pid}.${Date.now()}.act.tmp`;
      fs.writeFileSync(tmp, content, "utf8");
      fs.renameSync(tmp, filePath);
    },
    backupFile: () => {},
    validateModel: (map, pools) => require("../lib/runtime-transaction").validateRuntimeModel(map, pools),
    validateConfig: async () => { calls.validate += 1; },
    reloadPhp: async () => { calls.reloadPhp += 1; },
    reloadNginx: async () => { calls.reloadNginx += 1; },
    verifyPorts: async (ports) => { calls.verified.push(ports); },
    ...overrides,
  };
  return { deps, calls, paths };
}

test("activateStaticMigration commits the plan through the controlled activation path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smg-act-"));
  try {
    const result = migrateStaticRoutes({
      mapContent: LEGACY_MAP,
      poolsContent: POOLS,
      nginxContent: NGINX,
      siteState: { sites: { "static.example": { siteType: "static" }, "dynamic.example": { siteType: "wordpress" } } },
    });
    const before = {
      map: LEGACY_MAP,
      pools: POOLS,
      nginx: NGINX,
      state: "{}",
      stateMode: 0o600,
    };
    const { deps, calls, paths } = makeActivationDeps(dir);
    const out = await activateStaticMigration({
      before,
      after: {
        mapContent: result.mapContent,
        poolsContent: result.poolsContent,
        nginxContent: result.nginxContent,
        state: "{}",
        stateMode: 0o600,
      },
      deps,
    });
    assert.equal(out.rollback, "not-required");
    assert.equal(calls.validate, 1);
    assert.equal(calls.reloadNginx, 1);
    assert.equal(calls.reloadPhp, 1);
    assert.ok(calls.verified.length >= 1);
    assert.match(fs.readFileSync(paths.poolsPath, "utf8"), /\[dynamic_example\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("activateStaticMigration restores all files on validation failure and reports rollback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smg-roll-"));
  try {
    const result = migrateStaticRoutes({
      mapContent: LEGACY_MAP,
      poolsContent: POOLS,
      nginxContent: NGINX,
      siteState: { sites: { "static.example": { siteType: "static" }, "dynamic.example": { siteType: "wordpress" } } },
    });
    const before = {
      map: LEGACY_MAP,
      pools: POOLS,
      nginx: NGINX,
      state: "{}",
      stateMode: 0o600,
    };
    const { deps, paths } = makeActivationDeps(dir, {
      validateConfig: (() => { let first = true; return async () => { if (first) { first = false; throw new Error("nginx -t failed"); } }; })(),
    });
    await assert.rejects(
      activateStaticMigration({
        before,
        after: {
          mapContent: result.mapContent,
          poolsContent: result.poolsContent,
          nginxContent: result.nginxContent,
          state: "{}",
          stateMode: 0o600,
        },
        deps,
      }),
      (error) => error.message.includes("nginx -t failed") && error.rollback === "succeeded",
    );
    assert.equal(fs.readFileSync(paths.sitesMapPath, "utf8"), LEGACY_MAP);
    assert.equal(fs.readFileSync(paths.poolsPath, "utf8"), POOLS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("activateStaticMigration rejects an invalid proposed model before reload", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smg-invalid-"));
  try {
    const { deps, calls } = makeActivationDeps(dir);
    const badAfter = {
      mapContent: [
        "map $host $site_root {", "  default /var/www/_default;", "}", "",
        "map $host $php_upstream {", "  default hosting-php-fpm:9000;", "}", "",
      ].join("\n"),
      poolsContent: "[a]\nlisten = 70000\n",
      nginxContent: NGINX,
      state: "{}",
      stateMode: 0o600,
    };
    await assert.rejects(
      activateStaticMigration({
        before: { map: LEGACY_MAP, pools: POOLS, nginx: NGINX, state: "{}", stateMode: 0o600 },
        after: badAfter,
        deps,
      }),
      /invalid listen port/,
    );
    assert.equal(calls.validate, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
