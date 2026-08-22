const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WordPressCacheControl, tokenHash } = require("../lib/wordpress-cache-control");

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-cache-control-"));
  const dataDir = path.join(root, "data");
  const websitesRoot = path.join(root, "websites");
  const pluginSource = path.join(root, "plugin.php");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(path.join(websitesRoot, "example.com", "wp-content"), { recursive: true });
  fs.writeFileSync(path.join(websitesRoot, "example.com", "wp-config.php"), "<?php\n");
  fs.writeFileSync(pluginSource, "<?php // package\n");
  let now = Date.parse("2026-08-22T12:00:00Z");
  return {
    root,
    site: { host: "example.com", directory: "example.com" },
    manager: new WordPressCacheControl({
      dataDir, websitesRoot, pluginSource, rateLimit: options.rateLimit || 20, now: () => now,
    }),
    advance(milliseconds) { now += milliseconds; },
  };
}

function installedToken(value) {
  const config = fs.readFileSync(path.join(value.root, "websites/example.com/wp-content/mu-plugins/hosting-cache-control-config.php"), "utf8");
  return /HOSTING_CACHE_CONTROL_TOKEN', '([^']+)'/.exec(config)[1];
}

test("installs idempotently and stores only a token hash in panel state", () => {
  const value = fixture();
  try {
    const first = value.manager.install(value.site);
    const token = installedToken(value);
    assert.equal(first.version, "1.0.0");
    assert.equal(token.length, 43);
    const stored = fs.readFileSync(value.manager.statePath, "utf8");
    assert.doesNotMatch(stored, new RegExp(token));
    assert.match(stored, new RegExp(tokenHash(token)));
    const second = value.manager.install(value.site);
    assert.equal(second.rotated, false);
    assert.equal(installedToken(value), token);
    assert.deepEqual(value.manager.status([value.site]).map(({ domain, installed, version }) => ({ domain, installed, version })), [
      { domain: "example.com", installed: true, version: "1.0.0" },
    ]);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("rotates credentials and rejects old, wrong-site, and rate-limited requests", () => {
  const value = fixture({ rateLimit: 2 });
  try {
    value.manager.install(value.site);
    const oldToken = installedToken(value);
    value.manager.install(value.site, { rotate: true });
    const token = installedToken(value);
    assert.notEqual(token, oldToken);
    assert.throws(() => value.manager.authenticate("example.com", oldToken), /authentication failed/);
    assert.throws(() => value.manager.authenticate("other.example", token), /authentication failed/);
    value.manager.authenticate("example.com", token, "127.0.0.1");
    value.manager.authenticate("example.com", token, "127.0.0.1");
    assert.throws(() => value.manager.authenticate("example.com", token, "127.0.0.1"), /rate limit/);
    value.advance(61_000);
    assert.doesNotThrow(() => value.manager.authenticate("example.com", token, "127.0.0.1"));
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("bulk install reports per-site failures and removal deletes only managed files", () => {
  const value = fixture();
  try {
    const result = value.manager.installMany([
      value.site,
      { host: "missing.example", directory: "missing.example" },
    ]);
    assert.equal(result.completed, 1);
    assert.equal(result.total, 2);
    assert.equal(result.results[1].ok, false);
    value.manager.remove(value.site);
    assert.equal(value.manager.status([value.site])[0].installed, false);
    assert.equal(fs.existsSync(path.join(value.root, "websites/example.com/wp-config.php")), true);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("rejects non-WordPress and escaping directories", () => {
  const value = fixture();
  try {
    assert.throws(() => value.manager.install({ host: "bad.example", directory: "../bad" }), /invalid|outside/);
    fs.mkdirSync(path.join(value.root, "websites/not-wp"));
    assert.throws(() => value.manager.install({ host: "not-wp.example", directory: "not-wp" }), /not a WordPress/);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("audit is bounded and excludes credentials", () => {
  const value = fixture();
  try {
    value.manager.maxAudit = 2;
    value.manager.install(value.site);
    const token = installedToken(value);
    value.manager.record("example.com", "purge", "success", ["fastcgi"]);
    value.manager.record("example.com", "purge", "failed", ["cloudflare"]);
    const stored = fs.readFileSync(value.manager.statePath, "utf8");
    assert.equal(value.manager.read().audit.length, 2);
    assert.doesNotMatch(stored, new RegExp(token));
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
