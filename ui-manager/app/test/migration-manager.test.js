const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  MigrationManager,
  newestDatabaseDump,
  resolveInside,
  transferId,
  validateImportPlan,
  validateManifest,
} = require("../lib/migration-manager");
const {
  annotateSiteAliases,
  parsePools,
  parseSitesMap,
  renderPools,
  renderSitesMap,
  setPoolOpcache,
} = require("../lib/runtime-config");

test("validates portable manifests and rejects paths outside the transfer directory", () => {
  const manifest = validateManifest({
    version: 1,
    type: "hosting-sites-export",
    sites: [{
      domain: "example.com",
      aliases: ["www.example.com"],
      canonicalAliases: ["www.example.com"],
      websitePath: "example.com",
      database: "yogali00_example_com",
      websiteArchive: "sites/example_com.tar.gz",
      databaseDump: "databases/yogali00_example_com_2026-07-19_02-00.sql.gz",
    }],
  });
  assert.equal(manifest.sites[0].poolTier, "medium");
  const staticManifest = validateManifest({
    version: 1,
    type: "hosting-sites-export",
    sites: [{
      domain: "static.example.com",
      siteType: "static",
      websitePath: "static.example.com",
      websiteArchive: "sites/static_example_com.tar.gz",
    }],
  });
  assert.equal(staticManifest.sites[0].siteType, "static");
  assert.equal(staticManifest.sites[0].database, "");
  assert.equal(staticManifest.sites[0].databaseDump, "");
  assert.throws(() => resolveInside("/tmp/import", "../private.sql.gz"), /Invalid path/);
  assert.throws(() => validateManifest({
    version: 1,
    type: "hosting-sites-export",
    sites: [{ domain: "example.com", websitePath: "../site", database: "db", databaseDump: "db.sql.gz" }],
  }), /website path/);
});

test("validates lightweight import JSON and applies safe defaults", () => {
  const plan = validateImportPlan({
    version: 1,
    type: "hosting-sites-import",
    sites: [{ websitePath: "example.com", domain: "example.com", aliases: ["www.example.com"] }],
  });
  assert.equal(plan.sites[0].poolTier, "medium");
  assert.deepEqual(plan.sites[0].state, {
    opcache: true,
    redis: false,
    fastcgiCache: false,
    backupEnabled: true,
  });
  assert.throws(() => validateImportPlan({
    version: 1,
    type: "hosting-sites-import",
    sites: [{ websitePath: "../example.com", domain: "example.com" }],
  }), /website path/);
  assert.throws(() => validateImportPlan({
    version: 1,
    type: "hosting-sites-import",
    sites: [
      { websitePath: "one", domain: "example.com", aliases: ["www.example.com"] },
      { websitePath: "two", domain: "www.example.com" },
    ],
  }), /Duplicate domain/);
});

test("selects the newest timestamped dump matching wp-config DB_NAME", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-dumps-"));
  try {
    fs.writeFileSync(path.join(directory, "yogali00_b389_2026-07-18_02-00.sql.gz"), "old");
    fs.writeFileSync(path.join(directory, "yogali00_b389_2026-07-19_02-00.sql.gz"), "new");
    fs.writeFileSync(path.join(directory, "yogali00_b389_archive_2027-07-20_02-00.sql.gz"), "wrong database");
    fs.writeFileSync(path.join(directory, "unrelated_2026-07-20_02-00.sql.gz"), "other");
    assert.equal(path.basename(newestDatabaseDump(directory, "yogali00_b389")), "yogali00_b389_2026-07-19_02-00.sql.gz");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("groups hosts sharing a document root and pool into one export site", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-runtime-"));
  try {
    const sitesMapPath = path.join(directory, "sites.map");
    const poolsPath = path.join(directory, "pools.conf");
    fs.writeFileSync(sitesMapPath, [
      "map $host $site_root {", "  default /var/www/_default;", "  example.com /var/www/example.com;", "  www.example.com /var/www/example.com;", "}", "",
      "map $host $php_upstream {", "  default hosting-php-fpm:9000;", "  example.com hosting-php-fpm:9001;", "  www.example.com hosting-php-fpm:9001;", "}", "",
      "map $host $canonical_host {", "  default \"\";", "  www.example.com example.com;", "}", "",
    ].join("\n"));
    fs.writeFileSync(poolsPath, "[www]\nlisten = 9000\n\n[example_com]\nlisten = 9001\npm.max_children = 6\n");
    const manager = new MigrationManager({
      dataDir: directory,
      exportsRoot: path.join(directory, "exports"),
      websitesRoot: path.join(directory, "websites"),
      sitesMapPath,
      poolsPath,
      siteState: { get: () => ({ opcache: true }) },
    });
    const sites = manager.primarySites();
    assert.equal(sites.length, 1);
    assert.equal(sites[0].host, "example.com");
    assert.deepEqual(sites[0].aliases, ["www.example.com"]);
    assert.deepEqual(sites[0].canonicalAliases, ["www.example.com"]);
    assert.equal(sites[0].poolTier, "medium");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("round trips runtime maps and pools", () => {
  const map = parseSitesMap("map $host $site_root {\n default /var/www/_default;\n}\nmap $host $php_upstream {\n default hosting-php-fpm:9000;\n}\nmap $host $canonical_host {\n default \"\";\n}\n");
  assert.deepEqual(parseSitesMap(renderSitesMap(map)), map);
  const pools = parsePools("[www]\nlisten = 9000\npm = ondemand\n");
  assert.deepEqual(parsePools(renderPools(pools)).sections, pools.sections);
  assert.equal(transferId(new Date("2026-07-19T02:00:00Z")), "export-2026-07-19_02-00");
});

test("enabled pools inherit global OPcache while disabled pools override it", () => {
  const settings = { listen: "9001", "php_admin_value[opcache.enable]": "1" };
  setPoolOpcache(settings, true);
  assert.equal(settings["php_admin_value[opcache.enable]"], undefined);
  setPoolOpcache(settings, false);
  assert.equal(settings["php_admin_value[opcache.enable]"], "0");
});

test("groups aliases by shared document root and PHP pool without requiring redirects", () => {
  const sites = annotateSiteAliases([
    { host: "www.example.com", root: "/var/www/example.com", port: 9001, canonicalTo: "" },
    { host: "example.com", root: "/var/www/example.com", port: 9001, canonicalTo: "" },
    { host: "shop.example.com", root: "/var/www/shop.example.com", port: 9002, canonicalTo: "" },
  ]);
  const primary = sites.find((site) => site.host === "example.com");
  const alias = sites.find((site) => site.host === "www.example.com");
  assert.equal(primary.isAlias, false);
  assert.deepEqual(primary.aliases, ["www.example.com"]);
  assert.equal(alias.isAlias, true);
  assert.equal(alias.primaryHost, "example.com");
  assert.equal(sites.find((site) => site.host === "shop.example.com").isAlias, false);
});

test("prefers an explicit canonical target as the primary host", () => {
  const sites = annotateSiteAliases([
    { host: "store.example.net", root: "/var/www/store", port: 9003, canonicalTo: "example.com" },
    { host: "example.com", root: "/var/www/store", port: 9003, canonicalTo: "" },
  ]);
  assert.equal(sites.find((site) => site.host === "example.com").isAlias, false);
  assert.equal(sites.find((site) => site.host === "store.example.net").primaryHost, "example.com");
});
