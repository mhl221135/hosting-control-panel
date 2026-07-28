const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
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

test("migrates an existing phase-one database to the payment schema", () => {
  const value = fixture();
  try {
    value.database.db.exec(`
      DROP TABLE webhook_deliveries;
      DROP TABLE payments;
      PRAGMA user_version=1;
    `);
    value.database.close();
    value.database.open();
    assert.equal(value.database.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    assert.equal(value.database.db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('payments','webhook_deliveries')",
    ).get().count, 2);
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
