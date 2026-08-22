const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SCRIPT = path.resolve(__dirname, "../../../scripts/generate-failover-hosts.sh");

function fixture(content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "failover-hosts-"));
  const sitesMap = path.join(directory, "sites.map");
  const websitesRoot = path.join(directory, "websites");
  const output = path.join(directory, "candidates.txt");
  fs.mkdirSync(websitesRoot);
  fs.writeFileSync(sitesMap, content);
  return { directory, sitesMap, websitesRoot, output };
}

function run(files) {
  return execFileSync(SCRIPT, [
    "--sites-map", files.sitesMap,
    "--websites-root", files.websitesRoot,
    "--output", files.output,
  ], {
    encoding: "utf8",
  });
}

test("generates sorted unique primary and alias failover candidates", (t) => {
  const files = fixture(`map $host $site_root {
  default /var/www/_default;
  WWW.Example.com /var/www/example.com;
  example.com /var/www/example.com;
  shop.example.net /var/www/shop.example.net;
  example.com /var/www/example.com;
}

map $host $php_upstream {
  default hosting-php-fpm:9000;
}
`);
  fs.mkdirSync(path.join(files.websitesRoot, "example.com"));
  fs.mkdirSync(path.join(files.websitesRoot, "shop.example.net"));
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  assert.match(run(files), /Generated 3 failover hostname candidates/);
  assert.equal(fs.readFileSync(files.output, "utf8"), "example.com\nshop.example.net\nwww.example.com\n");
  assert.equal(fs.statSync(files.output).mode & 0o777, 0o600);
});

test("rejects unsafe roots and malformed site map entries", (t) => {
  const unsafe = fixture(`map $host $site_root {
  default /var/www/_default;
  example.com /srv/outside;
}
`);
  const malformed = fixture(`map $host $site_root {
  default /var/www/_default;
  invalid host /var/www/example.com;
}
`);
  t.after(() => {
    fs.rmSync(unsafe.directory, { recursive: true, force: true });
    fs.rmSync(malformed.directory, { recursive: true, force: true });
  });
  assert.throws(() => run(unsafe), /Command failed/);
  assert.throws(() => run(malformed), /Command failed/);
  assert.equal(fs.existsSync(unsafe.output), false);
  assert.equal(fs.existsSync(malformed.output), false);
});

test("rejects mapped roots that were not restored", (t) => {
  const files = fixture(`map $host $site_root {
  default /var/www/_default;
  example.com /var/www/example.com;
  missing.example.net /var/www/missing.example.net;
}
`);
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const result = spawnSync(SCRIPT, [
    "--sites-map", files.sitesMap,
    "--websites-root", files.websitesRoot,
    "--output", files.output,
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Mapped website directories are unavailable/);
  assert.match(result.stderr, /example\.com/);
  assert.match(result.stderr, /missing\.example\.net/);
  assert.equal(fs.existsSync(files.output), false);
});

test("rejects a missing root map and symlink paths", (t) => {
  const missing = fixture("map $host $php_upstream {\n  default hosting-php-fpm:9000;\n}\n");
  const linked = fixture("map $host $site_root {\n  example.com /var/www/example.com;\n}\n");
  const target = path.join(linked.directory, "target.map");
  fs.renameSync(linked.sitesMap, target);
  fs.symlinkSync(target, linked.sitesMap);
  t.after(() => {
    fs.rmSync(missing.directory, { recursive: true, force: true });
    fs.rmSync(linked.directory, { recursive: true, force: true });
  });
  assert.throws(() => run(missing), /Command failed/);
  assert.throws(() => run(linked), /Command failed/);
});
