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
  validateManifest,
} = require("../lib/migration-manager");
const { parsePools, parseSitesMap, renderPools, renderSitesMap } = require("../lib/runtime-config");

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
  assert.throws(() => resolveInside("/tmp/import", "../private.sql.gz"), /Invalid path/);
  assert.throws(() => validateManifest({
    version: 1,
    type: "hosting-sites-export",
    sites: [{ domain: "example.com", websitePath: "../site", database: "db", databaseDump: "db.sql.gz" }],
  }), /website path/);
});

test("selects the newest timestamped dump matching wp-config DB_NAME", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-dumps-"));
  try {
    fs.writeFileSync(path.join(directory, "yogali00_b389_2026-07-18_02-00.sql.gz"), "old");
    fs.writeFileSync(path.join(directory, "yogali00_b389_2026-07-19_02-00.sql.gz"), "new");
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
