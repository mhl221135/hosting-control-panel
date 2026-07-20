const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { DEFAULTS, PerformanceSettings, renderNginx, renderPhpIni, validate } = require("../lib/performance-settings");

test("validates the 16 GB performance defaults", () => {
  assert.deepEqual(validate(DEFAULTS), DEFAULTS);
  assert.throws(() => validate({ mysql: { bufferPoolMb: 16000 } }), /MySQL buffer pool/);
  assert.throws(() => validate({ redis: { policy: "random" } }), /policy/);
});

test("renders PHP and nginx performance directives", () => {
  const php = renderPhpIni("memory_limit = 128M\nopcache.memory_consumption = 128\n", DEFAULTS);
  assert.match(php, /memory_limit = 512M/);
  assert.match(php, /opcache.memory_consumption = 512/);
  assert.match(php, /opcache.validate_timestamps = 1/);
  assert.match(php, /opcache.jit_buffer_size = 0/);

  const rendered = renderNginx(
    "fastcgi_read_timeout 60s;\nkeys_zone=WORDPRESS:64m\ninactive=30m\nmax_size=2g\n",
    "        fastcgi_cache_methods GET HEAD;\n        fastcgi_cache_valid 200 301 302 10m;\n",
    DEFAULTS,
  );
  assert.match(rendered.nginx, /keys_zone=WORDPRESS:128m/);
  assert.match(rendered.nginx, /max_size=8g/);
  assert.match(rendered.server, /fastcgi_cache_lock on/);
  assert.match(rendered.server, /fastcgi_cache_valid 200 301 302 30m/);
});

test("persists settings and writes managed runtime files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "performance-settings-"));
  try {
    const phpIniPath = path.join(directory, "global.ini");
    const nginxPath = path.join(directory, "nginx.conf");
    const nginxDefaultPath = path.join(directory, "default.conf");
    fs.writeFileSync(phpIniPath, "memory_limit = 128M\n");
    fs.writeFileSync(
      nginxPath,
      "fastcgi_read_timeout 60s;\nkeys_zone=WORDPRESS:64m\ninactive=30m\nmax_size=2g\n",
    );
    fs.writeFileSync(
      nginxDefaultPath,
      "        fastcgi_cache_methods GET HEAD;\n        fastcgi_cache_valid 200 301 302 10m;\n",
    );
    const manager = new PerformanceSettings({ dataDir: directory, phpIniPath, nginxPath, nginxDefaultPath });
    manager.save(DEFAULTS);
    manager.applyFiles();
    assert.equal(manager.read().mysql.bufferPoolMb, 4096);
    assert.match(fs.readFileSync(phpIniPath, "utf8"), /opcache.max_accelerated_files = 100000/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restores settings and runtime files after a failed apply", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "performance-rollback-"));
  try {
    const phpIniPath = path.join(directory, "global.ini");
    const nginxPath = path.join(directory, "nginx.conf");
    const nginxDefaultPath = path.join(directory, "default.conf");
    fs.writeFileSync(phpIniPath, "memory_limit = 128M\n");
    fs.writeFileSync(nginxPath, "fastcgi_read_timeout 60s;\nkeys_zone=WORDPRESS:64m inactive=30m max_size=2g\n");
    fs.writeFileSync(nginxDefaultPath, "        fastcgi_cache_methods GET HEAD;\n");
    const manager = new PerformanceSettings({ dataDir: directory, phpIniPath, nginxPath, nginxDefaultPath });
    const snapshot = manager.snapshot();
    manager.save(DEFAULTS);
    manager.applyFiles(DEFAULTS);
    manager.restore(snapshot);
    assert.equal(fs.existsSync(manager.path), false);
    assert.equal(fs.readFileSync(phpIniPath, "utf8"), "memory_limit = 128M\n");
    assert.match(fs.readFileSync(nginxPath, "utf8"), /keys_zone=WORDPRESS:64m/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
