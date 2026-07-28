const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

function waitForHealth(baseUrl, child) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = async () => {
      if (child.exitCode !== null) {
        reject(new Error(`Billing server exited with code ${child.exitCode}`));
        return;
      }
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {}
      if (Date.now() - started > 5000) reject(new Error("Billing server did not become healthy"));
      else setTimeout(attempt, 30);
    };
    attempt();
  });
}

test("serves the authenticated inventory, recovery, and signed internal API workflow", { timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-billing-server-"));
  const port = 20_000 + crypto.randomInt(20_000);
  const token = crypto.randomBytes(32).toString("hex");
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve(__dirname, "../app/server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: path.join(root, "data"),
      BACKUPS_ROOT: path.join(root, "backups"),
      BILLING_ADMIN_EMAIL: "billing@example.com",
      BILLING_ADMIN_PASSWORD: "billing-password-123",
      BILLING_API_TOKEN: token,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitForHealth(baseUrl, child);
    assert.equal((await (await fetch(`${baseUrl}/health`)).json()).schemaVersion, 2);
    assert.equal((await fetch(`${baseUrl}/internal/v1/entitlements`)).status, 401);

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "billing@example.com", password: "billing-password-123" }),
    });
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    const cookie = String(loginResponse.headers.get("set-cookie")).split(";")[0];
    const request = async (url, options = {}) => fetch(`${baseUrl}${url}`, {
      ...options,
      headers: {
        Cookie: cookie,
        ...(options.body ? { "Content-Type": "application/json", "X-CSRF-Token": login.csrf } : {}),
        ...(options.headers || {}),
      },
    });

    const csv = [
      "Order #,Website,Hosting Next Payment,Domain Next Payment,Price Hosting,Email",
      "42,example.com,2026-12-31,2027-01-15,120.00,owner@example.com",
    ].join("\n");
    const previewResponse = await request("/api/import/preview", {
      method: "POST",
      body: JSON.stringify({ csv }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    const applyResponse = await request("/api/import/apply", {
      method: "POST",
      body: JSON.stringify({ csv, fingerprint: preview.fingerprint, confirm: "IMPORT" }),
    });
    assert.equal(applyResponse.status, 200);

    const services = await (await request("/api/services")).json();
    assert.equal(services.services.length, 1);
    assert.equal(services.services[0].primary_domain, "example.com");
    const wooSettingsResponse = await request("/api/woocommerce/settings", {
      method: "PUT",
      body: JSON.stringify({
        site_url: "https://store.example.com",
        public_billing_url: "https://billing.example.com",
        product_id: 99,
        link_hours: 48,
        consumer_key: `ck_${"a".repeat(40)}`,
        consumer_secret: `cs_${"b".repeat(40)}`,
        webhook_secret: "webhook-secret-with-enough-entropy",
      }),
    });
    assert.equal(wooSettingsResponse.status, 200);
    const wooSettings = (await wooSettingsResponse.json()).settings;
    assert.equal(wooSettings.ready, true);
    assert.equal(JSON.stringify(wooSettings).includes("aaaa"), false);
    assert.equal((await fetch(`${baseUrl}/webhooks/woocommerce`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WC-Webhook-Signature": "forged",
        "X-WC-Webhook-Delivery-ID": "delivery-forged",
        "X-WC-Webhook-Topic": "order.updated",
      },
      body: JSON.stringify({ id: 99, status: "completed", total: "120.00", currency: "USD" }),
    })).status, 401);
    const exported = await request("/api/export.csv");
    assert.match(await exported.text(), /svc_[a-f0-9]+,example\.com/);

    const internal = await fetch(`${baseUrl}/internal/v1/entitlements`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(internal.status, 200);
    const feed = await internal.json();
    assert.equal(feed.services[0].primaryDomain, "example.com");
    assert.match(feed.signature, /^[A-Za-z0-9_-]{43}$/);

    const backupResponse = await request("/api/backups", { method: "POST", body: "{}" });
    assert.equal(backupResponse.status, 201);
    const backup = (await backupResponse.json()).backup;
    const restoreTest = await request(`/api/backups/${backup.id}/test`, { method: "POST", body: "{}" });
    assert.equal(restoreTest.status, 200);
    assert.equal((await restoreTest.json()).result.integrity, "ok");

    const audit = await (await request("/api/audit")).json();
    assert.equal(audit.audit.some((entry) => entry.action === "inventory.import"), true);
    assert.equal(audit.audit.some((entry) => entry.action === "backup.test"), true);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
  const unexpected = stderr.split(/\r?\n/).filter((line) =>
    line && !line.includes("ExperimentalWarning") && !line.includes("--trace-warnings")
      && !line.includes("POST /webhooks/woocommerce: Invalid WooCommerce webhook signature"));
  assert.deepEqual(unexpected, [], stderr);
});
