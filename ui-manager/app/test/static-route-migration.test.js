const assert = require("node:assert/strict");
const test = require("node:test");
const { parsePools, parseSitesMap, renderSitesMap } = require("../lib/runtime-config");
const { ensureStaticPhpGate, migrateStaticRoutes } = require("../lib/static-route-migration");

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
