const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { canonicalizePayload, verifySignature } = require("../app/lib/enrollment-signing");

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

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-enroll-api-"));
  const port = 30_000 + crypto.randomInt(10_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const runtimeFlags = process.execArgv.filter((flag) => flag === "--experimental-sqlite");
  const child = spawn(process.execPath, [...runtimeFlags, path.resolve(__dirname, "../app/server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: path.join(root, "data"),
      BACKUPS_ROOT: path.join(root, "backups"),
      BILLING_ADMIN_EMAIL: "billing@example.com",
      BILLING_ADMIN_PASSWORD: "billing-password-123",
      BILLING_API_TOKEN: crypto.randomBytes(32).toString("hex"),
      BILLING_SETTINGS_KEY: "test-only-billing-settings-key-32-bytes",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitForHealth(baseUrl, child);
  } catch (error) {
    throw new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`);
  }
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "billing@example.com", password: "billing-password-123" }),
  });
  const login = await loginResponse.json();
  const cookie = String(loginResponse.headers.get("set-cookie")).split(";")[0];
  const admin = async (url, options = {}) => fetch(`${baseUrl}${url}`, {
    ...options,
    headers: {
      Cookie: cookie,
      ...(options.body ? { "Content-Type": "application/json", "X-CSRF-Token": login.csrf } : {}),
      ...(options.headers || {}),
    },
  });
  return { baseUrl, root, child, get stderr() { return stderr; }, admin };
}

async function createSharedService(admin) {
  const csv = [
    "Order #,Website,Location,Hosting Next Payment,Price Hosting,Email",
    "200,remote.example.com,shared,2030-12-31,120.00,owner@remote.example.com",
  ].join("\n");
  const preview = await (await admin("/api/import/preview", { method: "POST", body: JSON.stringify({ csv }) })).json();
  const apply = await admin("/api/import/apply", {
    method: "POST",
    body: JSON.stringify({ csv, fingerprint: preview.fingerprint, confirm: "IMPORT" }),
  });
  assert.equal(apply.status, 200);
  const services = await (await admin("/api/services")).json();
  return services.services.find((s) => s.primary_domain === "remote.example.com");
}

test("billing server starts and enrollment routes require authentication and CSRF", { timeout: 30_000 }, async () => {
  const env = await boot();
  try {
    const health = await (await fetch(`${env.baseUrl}/health`)).json();
    assert.equal(health.ok, true);
    // Unauthenticated admin create code is rejected.
    const unauth = await fetch(`${env.baseUrl}/api/enrollment/codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service_id: "x", canonical_domain: "a.example.com" }),
    });
    assert.equal(unauth.status, 401);
    // Exchange is public.
    const exchangeNoBody = await fetch(`${env.baseUrl}/api/enrollment/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "abc", domain: "x.example.com" }),
    });
    assert.equal(exchangeNoBody.status, 400);
  } finally {
    env.child.kill();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test("creates and exchanges a code revealing each secret exactly once", { timeout: 30_000 }, async () => {
  const env = await boot();
  try {
    const service = await createSharedService(env.admin);
    const createdResponse = await env.admin("/api/enrollment/codes", {
      method: "POST",
      body: JSON.stringify({ service_id: service.service_id, canonical_domain: service.primary_domain, expires_in_hours: 24 }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.ok(created.code);
    assert.ok(created.codeId);

    // Exchange as the public one-time route (no session/cookie).
    const exchange = await fetch(`${env.baseUrl}/api/enrollment/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: created.code, domain: service.primary_domain }),
    });
    assert.equal(exchange.status, 200);
    const exchanged = await exchange.json();
    assert.ok(exchanged.installation_id);
    assert.ok(exchanged.credential);
    assert.equal("service_id" in exchanged, false);
    assert.equal("domain" in exchanged, false);

    // Replay is rejected.
    const replay = await fetch(`${env.baseUrl}/api/enrollment/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: created.code, domain: service.primary_domain }),
    });
    assert.equal(replay.status, 409);

    // Admin can list installations for the service.
    const list = await (await env.admin(`/api/enrollment/installations?service_id=${service.service_id}`)).json();
    assert.equal(list.installations.length, 1);
    assert.equal("credential_hash" in list.installations[0], false);
    assert.equal("code_hash" in list.installations[0], false);

    // Revoke the installation credential (idempotent) and it is listed as such.
    const revoke = await env.admin("/api/enrollment/installations/revoke", {
      method: "POST",
      body: JSON.stringify({ installation_id: exchanged.installation_id }),
    });
    assert.equal(revoke.status, 200);
    const revokedList = await (await env.admin(`/api/enrollment/installations?service_id=${service.service_id}`)).json();
    assert.ok(revokedList.installations[0].credential_revoked_at);
  } finally {
    env.child.kill();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test("enrollment routes reject unknown fields and invalid UUIDs without echoing secrets", { timeout: 30_000 }, async () => {
  const env = await boot();
  try {
    const service = await createSharedService(env.admin);
    const badField = await env.admin("/api/enrollment/codes", {
      method: "POST",
      body: JSON.stringify({ service_id: service.service_id, canonical_domain: service.primary_domain, malicious: 1 }),
    });
    assert.equal(badField.status, 400);
    assert.equal((await badField.text()).includes("service_id"), false);

    const badUuid = await env.admin("/api/enrollment/codes/revoke", {
      method: "POST",
      body: JSON.stringify({ code_id: "not-a-uuid" }),
    });
    assert.equal(badUuid.status, 400);

    const createdResponse = await env.admin("/api/enrollment/codes", {
      method: "POST",
      body: JSON.stringify({ service_id: service.service_id, canonical_domain: service.primary_domain, expires_in_hours: 24 }),
    });
    const created = await createdResponse.json();
    const wrongDomain = await fetch(`${env.baseUrl}/api/enrollment/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: created.code, domain: "notremote.example.com" }),
    });
    assert.equal(wrongDomain.status, 400);
    assert.equal((await wrongDomain.text()).includes(created.code), false);

    const coercibleHours = await env.admin("/api/enrollment/codes", {
      method: "POST",
      body: JSON.stringify({
        service_id: service.service_id,
        canonical_domain: service.primary_domain,
        expires_in_hours: "24",
      }),
    });
    assert.equal(coercibleHours.status, 400);

    const oversized = await fetch(`${env.baseUrl}/api/enrollment/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "a".repeat(5000), domain: service.primary_domain }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    env.child.kill();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test("initializes signing and serves a verifiable allowlisted entitlement", { timeout: 30_000 }, async () => {
  const env = await boot();
  try {
    const service = await createSharedService(env.admin);
    const settings = await env.admin("/api/woocommerce/settings", {
      method: "PUT",
      body: JSON.stringify({
        site_url: "https://store.example.com",
        public_billing_url: "https://billing.example.com",
        product_id: 123,
        link_hours: 72,
        consumer_key: `ck_${"a".repeat(30)}`,
        consumer_secret: `cs_${"b".repeat(30)}`,
        webhook_secret: "test-webhook-secret-at-least-24-characters",
      }),
    });
    assert.equal(settings.status, 200);

    const created = await (await env.admin("/api/enrollment/codes", {
      method: "POST",
      body: JSON.stringify({
        service_id: service.service_id,
        canonical_domain: service.primary_domain,
        expires_in_hours: 24,
      }),
    })).json();
    const exchanged = await (await fetch(`${env.baseUrl}/api/enrollment/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: created.code, domain: service.primary_domain }),
    })).json();

    const initialized = await env.admin("/api/enrollment/signing/initialize", {
      method: "POST",
      body: JSON.stringify({ confirm: "INITIALIZE" }),
    });
    assert.equal(initialized.status, 201);

    const entitlementResponse = await fetch(`${env.baseUrl}/remote/v1/entitlement`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${exchanged.credential}`,
        "X-Installation-Id": exchanged.installation_id,
      },
    });
    const entitlement = await entitlementResponse.json();
    assert.equal(entitlementResponse.status, 200, `${JSON.stringify(entitlement)}\n${env.stderr}`);
    assert.deepEqual(Object.keys(entitlement).sort(), ["ok", "payload", "signature"]);
    assert.equal(entitlement.payload.installation_id, exchanged.installation_id);
    assert.equal(entitlement.payload.approved_canonical_domain, service.primary_domain);
    assert.equal(entitlement.payload.enforcement_enabled, false);
    assert.match(entitlement.payload.renewal_url, /\/renew\/r1_[A-Za-z0-9_-]{43}$/);
    assert.equal(entitlement.payload.renewal_url.includes(service.service_id), false);

    const keysResponse = await fetch(`${env.baseUrl}/remote/v1/keys`);
    assert.equal(keysResponse.status, 200);
    const keys = await keysResponse.json();
    assert.equal(keys.keys.length, 1);
    assert.equal(keys.keys[0].active, true);
    assert.equal(
      verifySignature(keys.keys[0].public_key, canonicalizePayload(entitlement.payload), entitlement.signature),
      true,
    );

    const listed = await (await env.admin(`/api/enrollment/installations?service_id=${service.service_id}`)).json();
    assert.equal(listed.installations[0].contract_version, 1);
    assert.equal(listed.installations[0].safe_status, entitlement.payload.entitlement_state);

    const invalid = await fetch(`${env.baseUrl}/remote/v1/entitlement`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${"x".repeat(43)}`,
        "X-Installation-Id": exchanged.installation_id,
      },
    });
    assert.equal(invalid.status, 401);
  } finally {
    env.child.kill();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
