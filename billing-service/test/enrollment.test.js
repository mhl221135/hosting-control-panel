const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { importCsv } = require("../app/lib/csv");
const { exportCsv } = require("../app/lib/csv");
const { BillingDatabase, SCHEMA_VERSION, enrollmentHash } = require("../app/lib/database");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-enroll-test-"));
  const data = path.join(root, "data");
  const database = new BillingDatabase(data);
  return { root, database };
}

function sharedService(domain = "remote.example.com", source = "55") {
  const service = importCsv([
    "Order #,Website,Location,Hosting Next Payment,Price Hosting,Email",
    `${source},${domain},shared,2030-12-31,120.00,owner@${domain}`,
  ].join("\n")).services[0];
  return { ...service, location: "shared" };
}

function legacyService(domain = "local.example.com", source = "66") {
  const service = importCsv([
    "Order #,Website,Hosting Next Payment,Price Hosting,Email",
    `${source},${domain},2030-12-31,120.00,owner@${domain}`,
  ].join("\n")).services[0];
  return { ...service, location: "local" };
}

test("fresh schema creates enrollment tables at version 8", () => {
  const value = fixture();
  try {
    assert.equal(SCHEMA_VERSION, 8);
    assert.equal(value.database.db.prepare("PRAGMA user_version").get().user_version, 8);
    const enrollmentColumns = value.database.db.prepare("PRAGMA table_info(enrollment_codes)").all().map((c) => c.name);
    const installationColumns = value.database.db.prepare("PRAGMA table_info(wp_installations)").all().map((c) => c.name);
    assert.ok(enrollmentColumns.includes("code_id"));
    assert.ok(enrollmentColumns.includes("code_hash"));
    assert.ok(enrollmentColumns.includes("service_id"));
    assert.ok(enrollmentColumns.includes("used_at"));
    assert.ok(enrollmentColumns.includes("used_by_installation_id"));
    assert.ok(installationColumns.includes("installation_id"));
    assert.ok(installationColumns.includes("credential_hash"));
    assert.ok(installationColumns.includes("enrollment_code_id"));
    assert.ok(installationColumns.includes("last_seen_at"));
    assert.ok(installationColumns.includes("last_success_at"));
    const signingColumns = value.database.db.prepare("PRAGMA table_info(signing_keys)").all().map((c) => c.name);
    assert.ok(signingColumns.includes("public_key"));
    assert.ok(signingColumns.includes("private_key_encrypted"));
    assert.ok(signingColumns.includes("is_active"));
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("migrates a schema-six database to version 8 and preserves data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-enroll-migration-"));
  const data = path.join(root, "data");
  fs.mkdirSync(data, { recursive: true });
  const legacy = new DatabaseSync(path.join(data, "billing.sqlite"));
  legacy.exec(`
    CREATE TABLE services (
      service_id TEXT PRIMARY KEY, primary_domain TEXT NOT NULL UNIQUE COLLATE NOCASE,
      aliases_json TEXT NOT NULL, customer_name TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '', contact_phone TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '',
      hosting_paid_through TEXT NOT NULL DEFAULT '', domain_paid_through TEXT NOT NULL DEFAULT '',
      renewal_months INTEGER NOT NULL, domain_renewal_months INTEGER NOT NULL,
      hosting_price_minor INTEGER NOT NULL, domain_price_minor INTEGER NOT NULL,
      currency TEXT NOT NULL, grace_days INTEGER NOT NULL,
      enforcement_mode TEXT NOT NULL DEFAULT 'none', manual_state TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'UTC', notes TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE events (event_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, event_type TEXT NOT NULL, happened_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE audit (audit_id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, summary_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE imports (fingerprint TEXT PRIMARY KEY, actor TEXT NOT NULL, row_count INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE payments (
      payment_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      nonce TEXT NOT NULL UNIQUE, woo_order_id INTEGER NOT NULL UNIQUE, checkout_url TEXT NOT NULL,
      amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, months INTEGER NOT NULL,
      resulting_paid_through TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL,
      paid_at TEXT NOT NULL, created_at TEXT NOT NULL, selection TEXT NOT NULL,
      hosting_months INTEGER NOT NULL, domain_months INTEGER NOT NULL,
      resulting_hosting_paid_through TEXT NOT NULL, resulting_domain_paid_through TEXT NOT NULL,
      review_required INTEGER NOT NULL DEFAULT 0, review_reason TEXT NOT NULL DEFAULT '',
      review_opened_at TEXT NOT NULL DEFAULT '', review_resolved_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO services VALUES(
      'svc_legacy','example.com','[]','','','','shared','','2030-12-31','2031-01-01',
      18,24,8000,1500,'USD',7,'none','','UTC','notes','',0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'
    );
    PRAGMA user_version=6;
  `);
  legacy.close();
  const database = new BillingDatabase(data);
  try {
    assert.equal(database.db.prepare("PRAGMA user_version").get().user_version, 8);
    const table = database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('enrollment_codes','wp_installations','signing_keys')").all();
    assert.equal(table.length, 3);
    const heartbeatColumns = database.db.prepare("PRAGMA table_info(wp_installations)").all().map((c) => c.name);
    assert.ok(heartbeatColumns.includes("last_seen_at"));
    assert.ok(heartbeatColumns.includes("last_success_at"));
    const service = database.service("svc_legacy");
    assert.equal(service.primary_domain, "example.com");
    assert.equal(service.renewal_months, 18);
    assert.equal(database.listInstallationsForService("svc_legacy").length, 0);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("enrollment code and installation credential are stored only as hashes with consistent IDs", () => {
  const value = fixture();
  try {
    const service = value.database.createService(sharedService(), "admin@example.com");
    const created = value.database.createEnrollmentCode({
      serviceId: service.service_id,
      canonicalDomain: service.primary_domain,
      expiresInHours: 24,
      actor: "admin@example.com",
    });
    const stored = value.database.db.prepare(
      "SELECT code_id, code_hash, created_by FROM enrollment_codes WHERE code_id=?",
    ).get(created.codeId);
    assert.equal(stored.code_id, created.codeId);
    assert.equal(stored.code_hash, enrollmentHash(created.code));
    assert.notEqual(stored.code_hash, created.code);
    assert.equal(stored.created_by, "admin@example.com");

    const exchanged = value.database.exchangeEnrollmentCode({ code: created.code, domain: service.primary_domain });
    const installation = value.database.db.prepare(
      "SELECT installation_id, credential_hash, enrollment_code_id FROM wp_installations WHERE installation_id=?",
    ).get(exchanged.installationId);
    assert.equal(installation.installation_id, exchanged.installationId);
    assert.equal(installation.credential_hash, enrollmentHash(exchanged.credential));
    assert.notEqual(installation.credential_hash, exchanged.credential);
    assert.equal(installation.enrollment_code_id, created.codeId);
    const codeAfter = value.database.db.prepare(
      "SELECT used_by_installation_id FROM enrollment_codes WHERE code_id=?",
    ).get(created.codeId);
    assert.equal(codeAfter.used_by_installation_id, exchanged.installationId);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("enrollment code is single-use and rejects replay, expiry, and revocation", () => {
  const value = fixture();
  try {
    // Replay rejection on the same service after a successful exchange.
    const service = value.database.createService(sharedService("remote8.example.com", "120"), "admin@example.com");
    const created = value.database.createEnrollmentCode({ serviceId: service.service_id, canonicalDomain: service.primary_domain, expiresInHours: 24, actor: "admin@example.com" });
    const first = value.database.exchangeEnrollmentCode({ code: created.code, domain: service.primary_domain });
    assert.ok(first.installationId);
    assert.throws(
      () => value.database.exchangeEnrollmentCode({ code: created.code, domain: service.primary_domain }),
      /already used/,
    );

    // Revocation rejects a not-yet-used code on a fresh service.
    const revokeService = value.database.createService(sharedService("remote9.example.com", "121"), "admin@example.com");
    const revocable = value.database.createEnrollmentCode({ serviceId: revokeService.service_id, canonicalDomain: revokeService.primary_domain, expiresInHours: 24, actor: "admin@example.com" });
    value.database.revokeEnrollmentCode(revocable.codeId, "admin@example.com");
    assert.throws(
      () => value.database.exchangeEnrollmentCode({ code: revocable.code, domain: revokeService.primary_domain }),
      /revoked/,
    );

    // Expired code is rejected.
    const expiryService = value.database.createService(sharedService("remote10.example.com", "122"), "admin@example.com");
    const expiring = value.database.createEnrollmentCode({ serviceId: expiryService.service_id, canonicalDomain: expiryService.primary_domain, expiresInHours: 24, actor: "admin@example.com" });
    value.database.db.prepare("UPDATE enrollment_codes SET expires_at=? WHERE code_id=?").run("2020-01-01T00:00:00.000Z", expiring.codeId);
    assert.throws(
      () => value.database.exchangeEnrollmentCode({ code: expiring.code, domain: expiryService.primary_domain }),
      /expired/,
    );
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("exchange rejects canonical-domain mismatch and ineligible or archived services", () => {
  const value = fixture();
  try {
    const local = value.database.createService(legacyService(), "admin@example.com");
    assert.throws(
      () => value.database.createEnrollmentCode({ serviceId: local.service_id, canonicalDomain: local.primary_domain, expiresInHours: 24, actor: "admin@example.com" }),
      /shared-hosting WordPress/,
    );
    const service = value.database.createService(sharedService("remote2.example.com", "77"), "admin@example.com");
    const created = value.database.createEnrollmentCode({ serviceId: service.service_id, canonicalDomain: service.primary_domain, expiresInHours: 24, actor: "admin@example.com" });
    assert.throws(
      () => value.database.exchangeEnrollmentCode({ code: created.code, domain: "www.remote2.example.com" }),
      /does not match/,
    );
    // Archive the service, then a fresh code must be rejected.
    value.database.archiveService(service.service_id, true, service.updated_at, "admin@example.com");
    assert.throws(
      () => value.database.createEnrollmentCode({ serviceId: service.service_id, canonicalDomain: service.primary_domain, expiresInHours: 24, actor: "admin@example.com" }),
      /archived/,
    );
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("duplicate active installation and pending code are rejected atomically", () => {
  const value = fixture();
  try {
    const service = value.database.createService(sharedService("remote3.example.com", "88"), "admin@example.com");
    const first = value.database.createEnrollmentCode({ serviceId: service.service_id, canonicalDomain: service.primary_domain, expiresInHours: 24, actor: "admin@example.com" });
    value.database.exchangeEnrollmentCode({ code: first.code, domain: service.primary_domain });
    // A second code is rejected because an active installation exists.
    assert.throws(
      () => value.database.createEnrollmentCode({ serviceId: service.service_id, canonicalDomain: service.primary_domain, expiresInHours: 24, actor: "admin@example.com" }),
      /active installation already exists/,
    );
    // A fresh service allows a pending code but not a second pending code.
    const secondService = value.database.createService(sharedService("remote4.example.com", "99"), "admin@example.com");
    value.database.createEnrollmentCode({ serviceId: secondService.service_id, canonicalDomain: secondService.primary_domain, expiresInHours: 24, actor: "admin@example.com" });
    assert.throws(
      () => value.database.createEnrollmentCode({ serviceId: secondService.service_id, canonicalDomain: secondService.primary_domain, expiresInHours: 24, actor: "admin@example.com" }),
      /pending enrollment code already exists/,
    );
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("credential and code revocation are idempotent and list views omit hashes", () => {
  const value = fixture();
  try {
    const service = value.database.createService(sharedService("remote5.example.com", "110"), "admin@example.com");
    const created = value.database.createEnrollmentCode({ serviceId: service.service_id, canonicalDomain: service.primary_domain, expiresInHours: 24, actor: "admin@example.com" });
    value.database.revokeEnrollmentCode(created.codeId, "admin@example.com");
    value.database.revokeEnrollmentCode(created.codeId, "admin@example.com");

    const secondService = value.database.createService(sharedService("remote6.example.com", "111"), "admin@example.com");
    const code = value.database.createEnrollmentCode({ serviceId: secondService.service_id, canonicalDomain: secondService.primary_domain, expiresInHours: 24, actor: "admin@example.com" });
    const exchanged = value.database.exchangeEnrollmentCode({ code: code.code, domain: secondService.primary_domain });
    value.database.revokeInstallationCredential(exchanged.installationId, "admin@example.com");
    value.database.revokeInstallationCredential(exchanged.installationId, "admin@example.com");

    const installations = value.database.listInstallationsForService(secondService.service_id);
    assert.equal(installations.length, 1);
    assert.equal("credential_hash" in installations[0], false);
    assert.equal("code_hash" in installations[0], false);
    const health = value.database.getInstallationHealth(exchanged.installationId);
    assert.ok(health);
    assert.equal("credential_hash" in health, false);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("audit and CSV export exclude plaintext codes, credentials, and hashes", () => {
  const value = fixture();
  try {
    const service = value.database.createService(sharedService("remote7.example.com", "112"), "admin@example.com");
    const created = value.database.createEnrollmentCode({ serviceId: service.service_id, canonicalDomain: service.primary_domain, expiresInHours: 24, actor: "admin@example.com" });
    const exchanged = value.database.exchangeEnrollmentCode({ code: created.code, domain: service.primary_domain });
    const audit = JSON.stringify(value.database.audit());
    assert.equal(audit.includes(created.code), false);
    assert.equal(audit.includes(exchanged.credential), false);
    assert.equal(audit.includes(enrollmentHash(exchanged.credential)), false);
    const csv = exportCsv(value.database.services());
    assert.equal(csv.includes(created.code), false);
    assert.equal(csv.includes(exchanged.credential), false);
    assert.equal(csv.includes(exchanged.installationId), false);
    assert.equal(csv.includes(enrollmentHash(exchanged.credential)), false);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
