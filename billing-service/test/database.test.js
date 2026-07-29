const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { BillingBackups } = require("../app/lib/backups");
const { importCsv } = require("../app/lib/csv");
const { BillingDatabase, SCHEMA_VERSION } = require("../app/lib/database");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-billing-test-"));
  const data = path.join(root, "data");
  const backupRoot = path.join(root, "backups");
  const database = new BillingDatabase(data);
  return { root, database, backups: new BillingBackups(database, backupRoot, 3) };
}

function inventory(domain = "example.com", source = "42") {
  return importCsv([
    "Order #,Website,Hosting Next Payment,Domain Next Payment,Price Hosting,Email",
    `${source},${domain},2026-12-31,2027-01-15,120.00,owner@${domain}`,
  ].join("\n"));
}

test("migrates, imports atomically, audits, and blocks replayed inventory", () => {
  const value = fixture();
  try {
    const input = inventory();
    const result = value.database.importServices(input.services, input.fingerprint, "admin@example.com");
    assert.deepEqual(result, { rows: 1, inserted: 1, updated: 0 });
    assert.equal(value.database.services()[0].primary_domain, "example.com");
    assert.equal(value.database.audit()[0].action, "inventory.import");
    assert.throws(
      () => value.database.importServices(input.services, input.fingerprint, "admin@example.com"),
      /already imported/,
    );
    assert.equal(value.database.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("migrates an existing schema-three database without changing renewal dates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-billing-migration-"));
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
      renewal_months INTEGER NOT NULL, hosting_price_minor INTEGER NOT NULL,
      domain_price_minor INTEGER NOT NULL, currency TEXT NOT NULL, grace_days INTEGER NOT NULL,
      enforcement_mode TEXT NOT NULL DEFAULT 'none', manual_state TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'UTC', notes TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES('reminder_days','30');
    CREATE TABLE payments (
      payment_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      nonce TEXT NOT NULL UNIQUE, woo_order_id INTEGER NOT NULL UNIQUE, checkout_url TEXT NOT NULL,
      amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, months INTEGER NOT NULL,
      resulting_paid_through TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL,
      paid_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    INSERT INTO services VALUES(
      'svc_migration_example_1','example.com','[]','','','','local','','2026-12-31',
      '2027-01-15',18,8000,1500,'USD',7,'none','','UTC','','',
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'
    );
    PRAGMA user_version=3;
  `);
  legacy.close();
  const database = new BillingDatabase(data);
  try {
    const service = database.service("svc_migration_example_1");
    assert.equal(database.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    assert.equal(service.renewal_months, 18);
    assert.equal(service.domain_renewal_months, 18);
    assert.equal(service.hosting_paid_through, "2026-12-31");
    assert.equal(service.archived, false);
    const columns = database.db.prepare("PRAGMA table_info(payments)").all().map((column) => column.name);
    assert.equal(columns.includes("selection"), true);
    assert.equal(columns.includes("resulting_domain_paid_through"), true);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("creates, updates, archives, restores, and rejects stale writes", () => {
  const value = fixture();
  try {
    const service = inventory("managed.example.com", "44").services[0];
    service.domain_renewal_months = 24;
    const created = value.database.createService(service, "admin@example.com");
    assert.equal(created.domain_renewal_months, 24);
    const updated = value.database.updateService(created.service_id, {
      ...service,
      primary_domain: "renamed.example.com",
      aliases: ["www.renamed.example.com"],
    }, created.updated_at, "admin@example.com");
    assert.equal(updated.primary_domain, "renamed.example.com");
    assert.throws(
      () => value.database.updateService(created.service_id, service, created.updated_at, "admin@example.com"),
      /another session/,
    );
    const exempted = value.database.applyManualAction(
      created.service_id, "exempt", "Complimentary hosting", updated.updated_at, "admin@example.com",
    );
    assert.equal(exempted.manual_state, "exempt");
    assert.equal(value.database.audit()[0].action, "inventory.manual_exempt");
    assert.equal(value.database.audit()[0].summary.reason, "Complimentary hosting");
    assert.throws(
      () => value.database.applyManualAction(
        created.service_id, "suspend", "Stale operator request", updated.updated_at, "admin@example.com",
      ),
      /another session/,
    );
    const suspended = value.database.applyManualAction(
      created.service_id, "suspend", "Payment requires review", exempted.updated_at, "admin@example.com",
    );
    assert.equal(suspended.manual_state, "suspended");
    const resumed = value.database.applyManualAction(
      created.service_id, "resume", "Review completed", suspended.updated_at, "admin@example.com",
    );
    assert.equal(resumed.manual_state, "");
    const archived = value.database.archiveService(
      created.service_id, true, resumed.updated_at, "admin@example.com",
    );
    assert.equal(archived.archived, true);
    assert.throws(
      () => value.database.applyManualAction(
        created.service_id, "exempt", "Archived record", archived.updated_at, "admin@example.com",
      ),
      /Restore the archived service/,
    );
    assert.throws(
      () => value.database.applyManualAction(
        created.service_id, "exempt", "x", archived.updated_at, "admin@example.com",
      ),
      /at least 3 characters/,
    );
    assert.equal(value.database.services().length, 0);
    assert.equal(value.database.services({ archived: "only" }).length, 1);
    const restored = value.database.archiveService(
      created.service_id, false, archived.updated_at, "admin@example.com",
    );
    assert.equal(restored.archived, false);
    assert.equal(value.database.services().length, 1);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("creates verified backups, tests restore, and rolls data back with a safety snapshot", async () => {
  const value = fixture();
  try {
    const first = inventory();
    value.database.importServices(first.services, first.fingerprint, "admin@example.com");
    const snapshot = await value.backups.create("manual", "admin@example.com");
    assert.equal(snapshot.services, 1);
    assert.deepEqual(value.backups.test(snapshot.id), {
      ok: true,
      integrity: "ok",
      schemaVersion: SCHEMA_VERSION,
      services: 1,
    });

    const second = inventory("second.example.com", "43");
    value.database.importServices(second.services, second.fingerprint, "admin@example.com");
    assert.equal(value.database.services().length, 2);
    const restored = await value.backups.restore(snapshot.id, "admin@example.com");
    assert.equal(restored.restored, snapshot.id);
    assert.equal(value.database.services().length, 1);
    assert.equal(value.backups.list().some((item) => item.id === restored.safetyBackup), true);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
