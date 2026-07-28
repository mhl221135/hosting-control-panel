const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { stateForDate } = require("./validation");

const SCHEMA_VERSION = 1;

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowView(row, reminderDays, now = new Date()) {
  const service = {
    ...row,
    aliases: parseJson(row.aliases_json, []),
  };
  delete service.aliases_json;
  service.hosting_state = stateForDate(service.hosting_paid_through, {
    reminderDays,
    graceDays: service.grace_days,
  }, service.manual_state, now);
  service.domain_state = stateForDate(service.domain_paid_through, {
    reminderDays,
    graceDays: service.grace_days,
  }, service.manual_state === "exempt" ? "exempt" : "", now);
  return service;
}

class BillingDatabase {
  constructor(dataDir) {
    this.path = path.join(dataDir, "billing.sqlite");
    this.db = null;
    fs.mkdirSync(dataDir, { recursive: true });
    this.open();
  }

  open() {
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }

  migrate() {
    const current = Number(this.db.prepare("PRAGMA user_version").get().user_version || 0);
    if (current > SCHEMA_VERSION) throw new Error("Billing database was created by a newer service version");
    if (current < 1) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE services (
          service_id TEXT PRIMARY KEY,
          primary_domain TEXT NOT NULL UNIQUE COLLATE NOCASE,
          aliases_json TEXT NOT NULL,
          customer_name TEXT NOT NULL DEFAULT '',
          contact_email TEXT NOT NULL DEFAULT '',
          contact_phone TEXT NOT NULL DEFAULT '',
          location TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT '',
          hosting_paid_through TEXT NOT NULL DEFAULT '',
          domain_paid_through TEXT NOT NULL DEFAULT '',
          renewal_months INTEGER NOT NULL,
          hosting_price_minor INTEGER NOT NULL,
          domain_price_minor INTEGER NOT NULL,
          currency TEXT NOT NULL,
          grace_days INTEGER NOT NULL,
          enforcement_mode TEXT NOT NULL DEFAULT 'none',
          manual_state TEXT NOT NULL DEFAULT '',
          timezone TEXT NOT NULL DEFAULT 'UTC',
          notes TEXT NOT NULL DEFAULT '',
          source_ref TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE events (
          event_id TEXT PRIMARY KEY,
          service_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          happened_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          FOREIGN KEY(service_id) REFERENCES services(service_id) ON DELETE RESTRICT
        );
        CREATE TABLE audit (
          audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE imports (
          fingerprint TEXT PRIMARY KEY,
          actor TEXT NOT NULL,
          row_count INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO settings(key, value) VALUES ('reminder_days', '30');
        PRAGMA user_version=1;
        COMMIT;
      `);
    }
  }

  transaction(operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reminderDays() {
    return Number(this.db.prepare("SELECT value FROM settings WHERE key='reminder_days'").get()?.value || 30);
  }

  updateReminderDays(value, actor) {
    const reminderDays = Number(value);
    if (!Number.isInteger(reminderDays) || reminderDays < 1 || reminderDays > 365) {
      throw Object.assign(new Error("Reminder window must be from 1 to 365 days"), { statusCode: 400 });
    }
    this.transaction(() => {
      this.db.prepare("INSERT INTO settings(key,value) VALUES('reminder_days',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(String(reminderDays));
      this.auditEntry(actor, "settings.update", "reminder_days", { reminderDays });
    });
    return reminderDays;
  }

  services(query = {}) {
    const rows = this.db.prepare("SELECT * FROM services ORDER BY primary_domain COLLATE NOCASE").all();
    const now = query.now || new Date();
    const search = String(query.search || "").trim().toLowerCase();
    const state = String(query.state || "");
    return rows.map((row) => rowView(row, this.reminderDays(), now)).filter((service) => {
      if (state && service.hosting_state !== state) return false;
      if (search && ![
        service.primary_domain, service.customer_name, service.contact_email,
        service.provider, service.source_ref,
      ].some((value) => String(value).toLowerCase().includes(search))) return false;
      return true;
    });
  }

  summary() {
    const services = this.services();
    const states = Object.fromEntries(["active", "reminder", "grace", "suspended", "exempt"]
      .map((state) => [state, services.filter((service) => service.hosting_state === state).length]));
    return { total: services.length, states, generatedAt: new Date().toISOString() };
  }

  audit(limit = 100) {
    return this.db.prepare("SELECT * FROM audit ORDER BY audit_id DESC LIMIT ?").all(Math.min(500, Math.max(1, limit)))
      .map((row) => ({ ...row, summary: parseJson(row.summary_json, {}), summary_json: undefined }));
  }

  auditEntry(actor, action, target, summary) {
    this.db.prepare(
      "INSERT INTO audit(actor,action,target,summary_json,created_at) VALUES(?,?,?,?,?)",
    ).run(actor, action, target, JSON.stringify(summary), new Date().toISOString());
    this.db.exec(`
      DELETE FROM audit
      WHERE audit_id NOT IN (SELECT audit_id FROM audit ORDER BY audit_id DESC LIMIT 5000);
    `);
  }

  importServices(services, fingerprint, actor) {
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM imports WHERE fingerprint=?").get(fingerprint)) {
        throw Object.assign(new Error("This exact CSV was already imported"), { statusCode: 409 });
      }
      const find = this.db.prepare("SELECT created_at FROM services WHERE service_id=?");
      const upsert = this.db.prepare(`
        INSERT INTO services(
          service_id,primary_domain,aliases_json,customer_name,contact_email,contact_phone,
          location,provider,hosting_paid_through,domain_paid_through,renewal_months,
          hosting_price_minor,domain_price_minor,currency,grace_days,enforcement_mode,
          manual_state,timezone,notes,source_ref,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(service_id) DO UPDATE SET
          primary_domain=excluded.primary_domain,aliases_json=excluded.aliases_json,
          customer_name=excluded.customer_name,contact_email=excluded.contact_email,
          contact_phone=excluded.contact_phone,location=excluded.location,provider=excluded.provider,
          hosting_paid_through=excluded.hosting_paid_through,domain_paid_through=excluded.domain_paid_through,
          renewal_months=excluded.renewal_months,hosting_price_minor=excluded.hosting_price_minor,
          domain_price_minor=excluded.domain_price_minor,currency=excluded.currency,
          grace_days=excluded.grace_days,enforcement_mode=excluded.enforcement_mode,
          manual_state=excluded.manual_state,timezone=excluded.timezone,notes=excluded.notes,
          source_ref=excluded.source_ref,updated_at=excluded.updated_at
      `);
      const event = this.db.prepare(
        "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
      );
      const timestamp = new Date().toISOString();
      let inserted = 0;
      let updated = 0;
      for (const service of services) {
        const existing = find.get(service.service_id);
        if (existing) updated += 1;
        else inserted += 1;
        upsert.run(
          service.service_id, service.primary_domain, JSON.stringify(service.aliases),
          service.customer_name, service.contact_email, service.contact_phone, service.location,
          service.provider, service.hosting_paid_through, service.domain_paid_through,
          service.renewal_months, service.hosting_price_minor, service.domain_price_minor,
          service.currency, service.grace_days, service.enforcement_mode, service.manual_state,
          service.timezone, service.notes, service.source_ref, existing?.created_at || timestamp, timestamp,
        );
        event.run(crypto.randomUUID(), service.service_id, "inventory.imported", timestamp, JSON.stringify({
          fingerprint,
          primaryDomain: service.primary_domain,
        }));
      }
      this.db.prepare("INSERT INTO imports(fingerprint,actor,row_count,created_at) VALUES(?,?,?,?)")
        .run(fingerprint, actor, services.length, timestamp);
      this.auditEntry(actor, "inventory.import", fingerprint, { rows: services.length, inserted, updated });
      return { rows: services.length, inserted, updated };
    });
  }

  integrity() {
    const result = this.db.prepare("PRAGMA integrity_check").get();
    return String(result.integrity_check || "").toLowerCase() === "ok";
  }

  healthy() {
    try {
      return Number(this.db.prepare("PRAGMA user_version").get().user_version) === SCHEMA_VERSION
        && Number(this.db.prepare("SELECT 1 AS ok").get().ok) === 1;
    } catch {
      return false;
    }
  }
}

module.exports = { BillingDatabase, SCHEMA_VERSION, rowView };
