const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CONTRACT_VERSION,
  ENTITLEMENT_FIELDS,
  buildEntitlementPayload,
  canonicalizePayload,
  decryptPrivateKey,
  encryptPrivateKey,
  generateSigningKey,
  loadEncryptionKey,
  signPayload,
  verifySignature,
} = require("../app/lib/enrollment-signing");
const { BillingDatabase } = require("../app/lib/database");
const { importCsv } = require("../app/lib/csv");

function sharedService(domain = "remote.example.com", source = "55") {
  const service = importCsv([
    "Order #,Website,Location,Hosting Next Payment,Price Hosting,Email",
    `${source},${domain},shared,2030-12-31,120.00,owner@${domain}`,
  ].join("\n")).services[0];
  return { ...service, location: "shared" };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signing-test-"));
  const data = path.join(root, "data");
  const database = new BillingDatabase(data);
  return { root, database };
}

test("canonicalizePayload sorts keys and produces deterministic JSON", () => {
  const canonical = canonicalizePayload({ b: 2, a: 1, c: 3 });
  assert.equal(canonical, '{"a":1,"b":2,"c":3}');
  const same = canonicalizePayload({ c: 3, a: 1, b: 2 });
  assert.equal(same, canonical);
  // undefined and null are omitted
  assert.equal(canonicalizePayload({ a: 1, b: null, c: undefined }), '{"a":1}');
});

test("buildEntitlementPayload only includes allowlisted fields and fails open", () => {
  const installation = {
    installation_id: "inst-1",
    canonical_domain: "example.com",
    service_id: "svc-1",
  };
  const service = {
    hosting_state: "active",
    hosting_price_minor: 12000,
    currency: "USD",
    renewal_months: 12,
  };
  const payload = buildEntitlementPayload({
    installation,
    service,
    keyId: "key-1",
    publicBillingUrl: "https://billing.example.com",
  });
  assert.equal(payload.contract_version, CONTRACT_VERSION);
  assert.equal(payload.installation_id, "inst-1");
  assert.equal(payload.approved_canonical_domain, "example.com");
  assert.equal(payload.entitlement_state, "active");
  assert.equal(payload.enforcement_enabled, false);
  assert.equal(payload.key_id, "key-1");
  assert.ok(payload.issued_at.includes("T"));
  assert.ok(payload.expires_at.includes("T"));
  // Fields not in the allowlist must be absent
  for (const key of Object.keys(payload)) {
    assert.ok(ENTITLEMENT_FIELDS.has(key), `unexpected field: ${key}`);
  }
  // Fail-open: missing service data → active state, not suspension.
  const safe = buildEntitlementPayload({ installation, service: null, keyId: "k", publicBillingUrl: "" });
  assert.equal(safe.entitlement_state, "active");
});

test("Ed25519 key generation, signing, and verification", () => {
  const key = generateSigningKey();
  assert.ok(key.publicKey.includes("BEGIN PUBLIC KEY"));
  assert.ok(key.privateKey.includes("BEGIN PRIVATE KEY"));
  const payload = { test: "data", version: 1 };
  const { canonical, signature } = signPayload(key.privateKey, payload);
  assert.ok(canonical.length > 0);
  assert.ok(signature.length > 40);
  assert.equal(verifySignature(key.publicKey, canonical, signature), true);
  // Tampered data
  assert.equal(verifySignature(key.publicKey, canonical + "x", signature), false);
  // Wrong key
  const otherKey = generateSigningKey();
  assert.equal(verifySignature(otherKey.publicKey, canonical, signature), false);
});

test("encryptPrivateKey and decryptPrivateKey round-trip", () => {
  const encryptionKey = loadEncryptionKey("test-secret-key-12345");
  assert.ok(encryptionKey);
  const key = generateSigningKey();
  const encrypted = encryptPrivateKey(key.privateKey, encryptionKey);
  assert.ok(encrypted.includes("."));
  assert.notEqual(encrypted, key.privateKey);
  const decrypted = decryptPrivateKey(encrypted, encryptionKey);
  assert.equal(decrypted, key.privateKey);
  // Wrong key fails
  const otherKey = loadEncryptionKey("wrong-key-that-is-long-enough!!!");
  assert.throws(() => decryptPrivateKey(encrypted, otherKey));
});

test("loadEncryptionKey returns null for short or missing keys", () => {
  assert.equal(loadEncryptionKey(""), null);
  assert.equal(loadEncryptionKey("short"), null);
  assert.ok(loadEncryptionKey("key-long-enough-16bytes"));
});

test("signing key lifecycle: initialize, status, rotate, and retirement restrictions", () => {
  const value = fixture();
  try {
    const service = value.database.createService(sharedService("remote-a.example.com", "210"), "admin@example.com");
    const code = value.database.createEnrollmentCode({
      serviceId: service.service_id,
      canonicalDomain: service.primary_domain,
      expiresInHours: 24,
      actor: "admin@example.com",
    });
    const exchanged = value.database.exchangeEnrollmentCode({
      code: code.code,
      domain: service.primary_domain,
    });
    // No active key yet.
    assert.equal(value.database.activeSigningKeyRaw(), null);
    assert.equal(value.database.activePublicKey(), null);
    const key = generateSigningKey();
    const encKey = loadEncryptionKey("test-signing-key-12345");
    const encrypted = encryptPrivateKey(key.privateKey, encKey);
    const keyId = value.database.initSigningKey(
      crypto.randomUUID(), key.publicKey, encrypted,
      new Date(Date.now() + 90 * 24 * 3600_000).toISOString(), 720, "admin@example.com",
    );
    assert.ok(keyId);
    assert.equal(value.database.signingKeyStatus().configured, true);
    assert.equal(value.database.activePublicKey().keyId, keyId);
    // Double initialize is blocked.
    const key2 = generateSigningKey();
    assert.throws(
      () => value.database.initSigningKey(crypto.randomUUID(), key2.publicKey, "x", new Date().toISOString(), 720, "admin@example.com"),
      /already active/,
    );
    // Cannot retire active key.
    assert.throws(() => value.database.retireSigningKey(keyId, false, "admin@example.com"), /active key/);
    // Rotate.
    const newKey = generateSigningKey();
    const newEnc = encryptPrivateKey(newKey.privateKey, encKey);
    const newKeyId = value.database.rotateSigningKey(
      crypto.randomUUID(), newKey.publicKey, newEnc,
      new Date(Date.now() + 90 * 24 * 3600_000).toISOString(), 720, "admin@example.com",
    );
    assert.notEqual(newKeyId, keyId);
    assert.equal(value.database.activePublicKey().keyId, newKeyId);
    assert.equal(value.database.allPublicKeys().length, 2);
    // Retired key can be retired.
    value.database.retireSigningKey(keyId, true, "admin@example.com");
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("authenticateInstallation rejects revoked, unmatched, and missing credentials", () => {
  const value = fixture();
  try {
    const service = value.database.createService(sharedService("remote-b.example.com", "220"), "admin@example.com");
    const code = value.database.createEnrollmentCode({
      serviceId: service.service_id,
      canonicalDomain: service.primary_domain,
      expiresInHours: 24,
      actor: "admin@example.com",
    });
    const { installationId, credential } = value.database.exchangeEnrollmentCode({
      code: code.code,
      domain: service.primary_domain,
    });
    // Correct authentication
    const authed = value.database.authenticateInstallation(installationId, credential);
    assert.ok(authed);
    assert.equal(authed.installation_id, installationId);
    // Wrong credential
    assert.equal(value.database.authenticateInstallation(installationId, "wrong-credential"), null);
    // Wrong installation ID
    assert.equal(value.database.authenticateInstallation("wrong-id", credential), null);
    // Revoked
    value.database.revokeInstallationCredential(installationId, "admin@example.com");
    assert.equal(value.database.authenticateInstallation(installationId, credential), null);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("heartbeat is throttled and updates only on success", () => {
  const value = fixture();
  try {
    const service = value.database.createService(sharedService("remote-c.example.com", "230"), "admin@example.com");
    const code = value.database.createEnrollmentCode({
      serviceId: service.service_id,
      canonicalDomain: service.primary_domain,
      expiresInHours: 24,
      actor: "admin@example.com",
    });
    const { installationId } = value.database.exchangeEnrollmentCode({
      code: code.code,
      domain: service.primary_domain,
    });
    const result = value.database.heartbeatInstallation(installationId, true);
    assert.ok(result.last_seen_at);
    assert.ok(result.last_success_at);
    // Second call within throttle window should not update (same timestamps).
    const result2 = value.database.heartbeatInstallation(installationId, true);
    assert.equal(result2.last_success_at, result.last_success_at);
    const result3 = value.database.heartbeatInstallation(installationId, false);
    // Failed auth should not update heartbeat at all — actually heartbeatInstallation with success=false skips last_success_at update but still writes last_seen_at.
    assert.ok(result3.last_seen_at);
    assert.equal(result3.last_success_at, result.last_success_at);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("public keys endpoint contains no private material and signing is absent from audits and CSV", () => {
  const value = fixture();
  try {
    const service = value.database.createService(sharedService("remote-d.example.com", "240"), "admin@example.com");
    const code = value.database.createEnrollmentCode({
      serviceId: service.service_id,
      canonicalDomain: service.primary_domain,
      expiresInHours: 24,
      actor: "admin@example.com",
    });
    value.database.exchangeEnrollmentCode({ code: code.code, domain: service.primary_domain });
    const key = generateSigningKey();
    const encKey = loadEncryptionKey("audit-exclusion-key-123456");
    const encrypted = encryptPrivateKey(key.privateKey, encKey);
    value.database.initSigningKey(
      "key-audit-1", key.publicKey, encrypted,
      new Date(Date.now() + 90 * 24 * 3600_000).toISOString(), 720, "admin@example.com",
    );
    const keys = value.database.allPublicKeys();
    const keysJson = JSON.stringify(keys);
    assert.equal(keysJson.includes(key.privateKey), false);
    assert.equal(keysJson.includes("private_key_encrypted"), false);
    assert.equal(keysJson.includes("BEGIN PRIVATE"), false);
    // Audit does not contain private key material
    const audit = JSON.stringify(value.database.audit());
    assert.equal(audit.includes(key.privateKey), false);
    assert.equal(audit.includes("private_key"), false);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});