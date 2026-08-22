const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AuthStore } = require("../lib/auth");

function waitForPort(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15_000);
    const read = (chunk) => {
      output += chunk.toString();
      const match = output.match(/UI manager listening on :(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
  });
}

test("standby HTTP fence permits only ingress metadata, verification, and bounded HA requests", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standby-http-"));
  const dataDir = path.join(root, "data");
  const markerDir = path.join(root, "marker");
  for (const dir of [dataDir, markerDir, "backups", "websites", "app-data", "exports", "imports", "offsite"].map((item) => path.isAbsolute(item) ? item : path.join(root, item))) fs.mkdirSync(dir, { recursive: true });
  const markerPath = path.join(markerDir, "role.json");
  fs.writeFileSync(markerPath, JSON.stringify({ version: 1, role: "standby", server_id: "test-standby" }));
  fs.writeFileSync(path.join(root, "sites.map"), "map $host $site_root {}\nmap $host $php_upstream {}\nmap $host $site_php_enabled {}\nmap $host $canonical_host {}\n");
  fs.writeFileSync(path.join(root, "pools.conf"), "");
  fs.writeFileSync(path.join(root, "cache.map"), "");
  const auth = new AuthStore(dataDir);
  const password = "test123456";
  const salt = crypto.randomBytes(16);
  fs.writeFileSync(path.join(dataDir, "admin-account.json"), JSON.stringify({ email: "admin@test.com", hash: crypto.scryptSync(password, salt, 64).toString("base64url"), salt: salt.toString("base64url") }));

  const child = spawn(process.execPath, [path.join(__dirname, "../server.js")], { env: {
    ...process.env, PORT: "0", DATA_DIR: dataDir, HOSTING_ROOT: root,
    BACKUPS_ROOT: path.join(root, "backups"), OFFSITE_BACKUPS_ROOT: path.join(root, "offsite"),
    WEBSITES_ROOT: path.join(root, "websites"), APP_DATA_ROOT: path.join(root, "app-data"),
    EXPORTS_ROOT: path.join(root, "exports"), IMPORTS_ROOT: path.join(root, "imports"),
    INSTALLATION_ROLE_PATH: markerPath, SITES_MAP_PATH: path.join(root, "sites.map"),
    POOLS_PATH: path.join(root, "pools.conf"), CACHE_MAP_PATH: path.join(root, "cache.map"),
    PHP_INI_PATH: path.join(root, "global.ini"), NGINX_CONFIG_PATH: path.join(root, "nginx.conf"),
    NGINX_DEFAULT_PATH: path.join(root, "default.conf"),
  }, stdio: ["ignore", "pipe", "pipe"] });

  try {
    const port = await waitForPort(child);
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@test.com", password }) });
    assert.equal(login.status, 200);
    const session = await login.json();
    const headers = { Cookie: login.headers.get("set-cookie").split(";")[0], "x-csrf-token": session.csrf, "Content-Type": "application/json" };
    const request = (url, method = "POST", body = {}) => fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: JSON.stringify(body) });

    assert.equal((await request("/api/system/role", "PUT", { ingress_mode: "cloudflare_tunnel" })).status, 200);
    assert.equal((await request("/api/system/role/extra", "PUT", { ingress_mode: "direct_npm" })).status, 423);
    assert.equal((await request("/api/system/role", "PUT", { role: "primary" })).status, 409);
    assert.equal((await request("/api/system/deep-verify", "POST")).status, 202);
    assert.equal((await request("/api/system/ha-control", "POST", { action: "finalize-standby", confirm: "FINALIZE-STANDBY" })).status, 202);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/system/promotion-preflight`, { headers })).status, 200);
    for (const [url, method] of [["/api/provision", "POST"], ["/api/site-removal", "POST"], ["/api/backups/restore", "POST"], ["/api/maintenance/run", "POST"], ["/api/cloudflare/automation/apply", "POST"], ["/api/npm/hosts/ensure", "POST"], ["/api/actions/reload_nginx", "POST"], ["/api/billing/enforcement/settings", "PUT"]]) {
      assert.equal((await request(url, method)).status, 423, `${method} ${url} must be fenced`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
