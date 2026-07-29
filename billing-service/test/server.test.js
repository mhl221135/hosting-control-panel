const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { PublicReference } = require("../app/lib/public-reference");

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
    assert.equal((await (await fetch(`${baseUrl}/health`)).json()).schemaVersion, 5);
    assert.equal((await fetch(`${baseUrl}/internal/v1/entitlements`)).status, 401);
    const registrationPayload = {
      primary_domain: "provisioned.example.com",
      aliases: ["www.provisioned.example.com"],
      customer_name: "Provisioned client",
      contact_email: "owner@provisioned.example.com",
      grant_free_period: true,
      trial_anchor: "2026-07-31",
      free_months: 6,
      renewal_months: 12,
      hosting_price_minor: 8000,
      domain_renewal_months: 12,
      domain_price_minor: 0,
      currency: "USD",
      grace_days: 7,
    };
    const register = () => fetch(`${baseUrl}/internal/v1/services`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "job_1234567890abcdef",
      },
      body: JSON.stringify(registrationPayload),
    });
    const registered = await register();
    assert.equal(registered.status, 201);
    assert.equal((await registered.json()).created, true);
    const replayed = await register();
    assert.equal(replayed.status, 200);
    assert.equal((await replayed.json()).created, false);
    assert.equal((await fetch(`${baseUrl}/internal/v1/services`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "job_1234567890abcdef" },
      body: JSON.stringify(registrationPayload),
    })).status, 401);
    const invalidRenewal = await fetch(`${baseUrl}/renew/r1_${"a".repeat(43)}`);
    assert.equal(invalidRenewal.status, 404);
    assert.doesNotMatch(await invalidRenewal.text(), /service_id|customer|email/i);

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
    assert.equal(services.services.length, 2);
    const provisionedService = services.services.find((service) =>
      service.primary_domain === "provisioned.example.com");
    assert.equal(provisionedService.hosting_paid_through, "2027-01-31");
    const importedService = services.services.find((service) => service.primary_domain === "example.com");
    assert.ok(importedService);
    const reference = new PublicReference(path.join(root, "data")).forService(importedService.service_id);
    const renewalPage = await fetch(`${baseUrl}/renew/${reference}`);
    assert.equal(renewalPage.status, 200);
    const renewalHtml = await renewalPage.text();
    assert.match(renewalHtml, /example\.com/);
    assert.doesNotMatch(renewalHtml, /owner@example\.com|customer_name|service_id/);
    assert.match(renewalHtml, /No payment option is currently available/);
    const referenceStatus = await request("/api/public-reference/status");
    assert.equal(referenceStatus.status, 200);
    assert.equal((await referenceStatus.json()).status.previous, null);
    const invalidRotation = await request("/api/public-reference/rotate", {
      method: "POST",
      body: JSON.stringify({ overlap_hours: 24, reason: "Scheduled rotation", confirm: "rotate" }),
    });
    assert.equal(invalidRotation.status, 400);
    const rotation = await request("/api/public-reference/rotate", {
      method: "POST",
      body: JSON.stringify({ overlap_hours: 24, reason: "Scheduled rotation", confirm: "ROTATE" }),
    });
    assert.equal(rotation.status, 200);
    const rotationStatus = (await rotation.json()).status;
    assert.equal(rotationStatus.previous.active, true);
    assert.equal(JSON.stringify(rotationStatus).includes("key"), false);
    assert.equal((await fetch(`${baseUrl}/renew/${reference}`)).status, 200);
    const rotatedReference = new PublicReference(path.join(root, "data")).forService(importedService.service_id);
    assert.notEqual(rotatedReference, reference);
    assert.equal((await fetch(`${baseUrl}/renew/${rotatedReference}`)).status, 200);
    const duplicateRotation = await request("/api/public-reference/rotate", {
      method: "POST",
      body: JSON.stringify({ overlap_hours: 24, reason: "Duplicate rotation", confirm: "ROTATE" }),
    });
    assert.equal(duplicateRotation.status, 409);
    const createdResponse = await request("/api/services", {
      method: "POST",
      body: JSON.stringify({
        primary_domain: "managed.example.com",
        customer_name: "Managed client",
        hosting_paid_through: "2027-01-01",
        domain_paid_through: "2027-02-01",
        renewal_months: 12,
        domain_renewal_months: 24,
        hosting_price: "80.00",
        domain_price: "18.50",
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()).service;
    assert.equal(created.domain_renewal_months, 24);
    const updatedResponse = await request(`/api/services/${created.service_id}`, {
      method: "PUT",
      body: JSON.stringify({
        ...created,
        primary_domain: "renamed.example.com",
        aliases: "www.renamed.example.com",
        hosting_price_minor: 9000,
      }),
    });
    assert.equal(updatedResponse.status, 200);
    const updated = (await updatedResponse.json()).service;
    assert.equal(updated.primary_domain, "renamed.example.com");
    assert.equal(updated.hosting_price_minor, 9000);
    const staleResponse = await request(`/api/services/${created.service_id}`, {
      method: "PUT",
      body: JSON.stringify({ ...created, primary_domain: "stale.example.com" }),
    });
    assert.equal(staleResponse.status, 409);
    const invalidAction = await request(`/api/services/${created.service_id}/actions/suspend`, {
      method: "POST",
      body: JSON.stringify({ reason: "x", updated_at: updated.updated_at }),
    });
    assert.equal(invalidAction.status, 400);
    const suspendedResponse = await request(`/api/services/${created.service_id}/actions/suspend`, {
      method: "POST",
      body: JSON.stringify({ reason: "Payment requires review", updated_at: updated.updated_at }),
    });
    assert.equal(suspendedResponse.status, 200);
    const suspended = (await suspendedResponse.json()).service;
    assert.equal(suspended.manual_state, "suspended");
    const staleAction = await request(`/api/services/${created.service_id}/actions/exempt`, {
      method: "POST",
      body: JSON.stringify({ reason: "Complimentary service", updated_at: updated.updated_at }),
    });
    assert.equal(staleAction.status, 409);
    const resumedResponse = await request(`/api/services/${created.service_id}/actions/resume`, {
      method: "POST",
      body: JSON.stringify({ reason: "Payment confirmed", updated_at: suspended.updated_at }),
    });
    assert.equal(resumedResponse.status, 200);
    const resumed = (await resumedResponse.json()).service;
    assert.equal(resumed.manual_state, "");
    const archivedResponse = await request(`/api/services/${created.service_id}/archive`, {
      method: "POST",
      body: JSON.stringify({ archived: true, updated_at: resumed.updated_at }),
    });
    assert.equal(archivedResponse.status, 200);
    assert.equal((await archivedResponse.json()).service.archived, true);
    assert.equal((await (await request("/api/services")).json()).services.length, 2);
    assert.equal((await (await request("/api/services?archived=only")).json()).services.length, 1);
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
      && !line.includes("This service changed in another session")
      && !line.includes("A reason of at least 3 characters is required")
      && !line.includes("Type ROTATE to confirm public renewal URL key rotation")
      && !line.includes("A previous key remains active until")
      && !line.includes("POST /webhooks/woocommerce: Invalid WooCommerce webhook signature"));
  assert.deepEqual(unexpected, [], stderr);
});
