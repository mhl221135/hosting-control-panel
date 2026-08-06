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

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-enroll-api-"));
  const port = 30_000 + crypto.randomInt(10_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve(__dirname, "../app/server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: path.join(root, "data"),
      BACKUPS_ROOT: path.join(root, "backups"),
      BILLING_ADMIN_EMAIL: "billing@example.com",
      BILLING_ADMIN_PASSWORD: "billing-password-123",
      BILLING_API_TOKEN: crypto.randomBytes(32).toString("hex"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitForHealth(baseUrl, child);
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
  return { baseUrl, root, child, stderr, admin };
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
  } finally {
    env.child.kill();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
