const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { stateForDate, domain, integer, bounded } = require("./validation");

const SCHEMA_VERSION = 8;
const MANUAL_ACTIONS = {
  exempt: "exempt",
  resume: "",
  suspend: "suspended",
};

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
  service.archived = Boolean(service.archived);
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

function databaseConflict(error) {
  if (String(error.message).includes("services.primary_domain")) {
    return Object.assign(new Error("A billing service already uses this primary domain"), { statusCode: 409 });
  }
  if (String(error.message).includes("services.service_id")) {
    return Object.assign(new Error("A billing service already uses this service ID"), { statusCode: 409 });
  }
  return error;
}

function nextTimestamp(previous = "") {
  const now = Date.now();
  const prior = Date.parse(previous);
  return new Date(Number.isFinite(prior) ? Math.max(now, prior + 1) : now).toISOString();
}

// One-way hash for enrollment codes and installation credentials. Only hashes
// are stored; plaintext secrets are revealed at most once and never persisted.
function enrollmentHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function auditSnapshot(service) {
  return {
    primary_domain: service.primary_domain,
    aliases: service.aliases,
    location: service.location,
    provider: service.provider,
    hosting_paid_through: service.hosting_paid_through,
    domain_paid_through: service.domain_paid_through,
    renewal_months: service.renewal_months,
    domain_renewal_months: service.domain_renewal_months,
    hosting_price_minor: service.hosting_price_minor,
    domain_price_minor: service.domain_price_minor,
    currency: service.currency,
    grace_days: service.grace_days,
    enforcement_mode: service.enforcement_mode,
    manual_state: service.manual_state,
    archived: Boolean(service.archived),
  };
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
    if (current < 2) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE payments (
          payment_id TEXT PRIMARY KEY,
          service_id TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          nonce TEXT NOT NULL UNIQUE,
          woo_order_id INTEGER NOT NULL UNIQUE,
          checkout_url TEXT NOT NULL,
          amount_minor INTEGER NOT NULL,
          currency TEXT NOT NULL,
          months INTEGER NOT NULL,
          resulting_paid_through TEXT NOT NULL,
          status TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          paid_at TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          FOREIGN KEY(service_id) REFERENCES services(service_id) ON DELETE RESTRICT
        );
        CREATE TABLE webhook_deliveries (
          delivery_id TEXT PRIMARY KEY,
          topic TEXT NOT NULL,
          resource_id INTEGER NOT NULL,
          result TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX payments_service_created ON payments(service_id, created_at DESC);
        PRAGMA user_version=2;
        COMMIT;
      `);
    }
    if (current < 3) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE reminder_outbox (
          reminder_key TEXT PRIMARY KEY,
          service_id TEXT NOT NULL,
          state TEXT NOT NULL,
          paid_through TEXT NOT NULL,
          days_remaining INTEGER NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT NOT NULL DEFAULT '',
          remote_delivery_id TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          sent_at TEXT NOT NULL DEFAULT '',
          FOREIGN KEY(service_id) REFERENCES services(service_id) ON DELETE RESTRICT
        );
        INSERT INTO settings(key,value) VALUES ('reminder_enabled','false');
        INSERT INTO settings(key,value) VALUES ('reminder_time','09:00');
        INSERT INTO settings(key,value) VALUES ('reminder_last_run','');
        PRAGMA user_version=3;
        COMMIT;
      `);
    }
    if (current < 4) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE services ADD COLUMN domain_renewal_months INTEGER NOT NULL DEFAULT 12;
        ALTER TABLE services ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
        UPDATE services SET domain_renewal_months=renewal_months;
        CREATE INDEX services_archived_domain ON services(archived, primary_domain COLLATE NOCASE);
        PRAGMA user_version=4;
        COMMIT;
      `);
    }
    if (current < 5) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE payments ADD COLUMN selection TEXT NOT NULL DEFAULT 'hosting';
        ALTER TABLE payments ADD COLUMN hosting_months INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE payments ADD COLUMN domain_months INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE payments ADD COLUMN resulting_hosting_paid_through TEXT NOT NULL DEFAULT '';
        ALTER TABLE payments ADD COLUMN resulting_domain_paid_through TEXT NOT NULL DEFAULT '';
        UPDATE payments SET
          selection='hosting',
          hosting_months=months,
          resulting_hosting_paid_through=resulting_paid_through;
        CREATE INDEX payments_service_selection_created
          ON payments(service_id, selection, created_at DESC);
        PRAGMA user_version=5;
        COMMIT;
      `);
    }
    if (current < 6) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE payments ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0
          CHECK(review_required IN (0,1));
        ALTER TABLE payments ADD COLUMN review_reason TEXT NOT NULL DEFAULT '';
        ALTER TABLE payments ADD COLUMN review_opened_at TEXT NOT NULL DEFAULT '';
        ALTER TABLE payments ADD COLUMN review_resolved_at TEXT NOT NULL DEFAULT '';
        CREATE INDEX payments_review_created
          ON payments(review_required, created_at DESC);
        PRAGMA user_version=6;
        COMMIT;
      `);
    }
    if (current < 7) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE enrollment_codes (
          code_id TEXT PRIMARY KEY,
          code_hash TEXT NOT NULL UNIQUE,
          service_id TEXT NOT NULL,
          canonical_domain TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT '',
          used_at TEXT NOT NULL DEFAULT '',
          used_by_installation_id TEXT NOT NULL DEFAULT '',
          revoked_at TEXT NOT NULL DEFAULT '',
          FOREIGN KEY(service_id) REFERENCES services(service_id) ON DELETE RESTRICT
        );
        CREATE INDEX idx_enrollment_codes_service ON enrollment_codes(service_id, created_at);
        CREATE INDEX idx_enrollment_codes_hash ON enrollment_codes(code_hash);
        CREATE TABLE wp_installations (
          installation_id TEXT PRIMARY KEY,
          service_id TEXT NOT NULL,
          canonical_domain TEXT NOT NULL,
          credential_hash TEXT NOT NULL,
          credential_created_at TEXT NOT NULL,
          credential_revoked_at TEXT NOT NULL DEFAULT '',
          enrollment_code_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(service_id) REFERENCES services(service_id) ON DELETE RESTRICT,
          FOREIGN KEY(enrollment_code_id) REFERENCES enrollment_codes(code_id) ON DELETE SET NULL
        );
        CREATE INDEX idx_wp_installations_service ON wp_installations(service_id);
        CREATE INDEX idx_wp_installations_domain ON wp_installations(canonical_domain);
        PRAGMA user_version=7;
        COMMIT;
      `);
    }
    if (current < 8) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE signing_keys (
          key_id TEXT PRIMARY KEY,
          public_key TEXT NOT NULL,
          private_key_encrypted TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          rotated_at TEXT NOT NULL DEFAULT '',
          retired_at TEXT NOT NULL DEFAULT '',
          overlap_hours INTEGER NOT NULL DEFAULT 720,
          created_by TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX idx_signing_keys_active ON signing_keys(is_active);
        ALTER TABLE wp_installations ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT '';
        ALTER TABLE wp_installations ADD COLUMN last_success_at TEXT NOT NULL DEFAULT '';
        ALTER TABLE wp_installations ADD COLUMN contract_version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE wp_installations ADD COLUMN safe_status TEXT NOT NULL DEFAULT '';
        PRAGMA user_version=8;
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

  reminderSettings() {
    const rows = this.db.prepare(
      "SELECT key,value FROM settings WHERE key IN ('reminder_enabled','reminder_time','reminder_last_run')",
    ).all();
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      enabled: values.reminder_enabled === "true",
      time: values.reminder_time || "09:00",
      lastRun: values.reminder_last_run || "",
    };
  }

  updateReminderSettings(input, actor) {
    const time = String(input.time || "");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw Object.assign(new Error("Reminder time must use HH:MM"), { statusCode: 400 });
    }
    const enabled = Boolean(input.enabled);
    this.transaction(() => {
      const upsert = this.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      upsert.run("reminder_enabled", String(enabled));
      upsert.run("reminder_time", time);
      this.auditEntry(actor, "reminder.settings_update", "schedule", { enabled, time });
    });
    return this.reminderSettings();
  }

  setReminderLastRun(date) {
    this.db.prepare("INSERT INTO settings(key,value) VALUES('reminder_last_run',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(date);
  }

  paymentOptionSettings() {
    const rows = this.db.prepare(
      "SELECT key,value FROM settings WHERE key IN ('payment_options_enabled','payment_options_time','payment_options_last_run')",
    ).all();
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      enabled: values.payment_options_enabled === "true",
      time: values.payment_options_time || "08:30",
      lastRun: values.payment_options_last_run || "",
    };
  }

  updatePaymentOptionSettings(input, actor) {
    const time = String(input.time || "");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw Object.assign(new Error("Payment option time must use HH:MM"), { statusCode: 400 });
    }
    if (typeof input.enabled !== "boolean") {
      throw Object.assign(new Error("Payment option enabled must be a boolean"), { statusCode: 400 });
    }
    const enabled = input.enabled;
    this.transaction(() => {
      const upsert = this.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      upsert.run("payment_options_enabled", String(enabled));
      upsert.run("payment_options_time", time);
      this.auditEntry(actor, "payment_options.settings_update", "schedule", { enabled, time });
    });
    return this.paymentOptionSettings();
  }

  setPaymentOptionLastRun(date) {
    this.db.prepare("INSERT INTO settings(key,value) VALUES('payment_options_last_run',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(date);
  }

  services(query = {}) {
    const rows = this.db.prepare("SELECT * FROM services ORDER BY primary_domain COLLATE NOCASE").all();
    const now = query.now || new Date();
    const search = String(query.search || "").trim().toLowerCase();
    const state = String(query.state || "");
    const archived = String(query.archived || "");
    return rows.map((row) => rowView(row, this.reminderDays(), now)).filter((service) => {
      if (archived === "only" && !service.archived) return false;
      if (archived !== "all" && archived !== "only" && service.archived) return false;
      if (state && service.hosting_state !== state) return false;
      if (search && ![
        service.primary_domain, service.customer_name, service.contact_email,
        service.provider, service.source_ref,
      ].some((value) => String(value).toLowerCase().includes(search))) return false;
      return true;
    });
  }

  service(serviceId) {
    const row = this.db.prepare("SELECT * FROM services WHERE service_id=?").get(String(serviceId || ""));
    return row ? rowView(row, this.reminderDays()) : null;
  }

  serviceByDomain(primaryDomain) {
    const row = this.db.prepare("SELECT * FROM services WHERE primary_domain=? COLLATE NOCASE")
      .get(String(primaryDomain || ""));
    return row ? rowView(row, this.reminderDays()) : null;
  }

  summary() {
    const services = this.services();
    const states = Object.fromEntries(["active", "reminder", "grace", "suspended", "exempt"]
      .map((state) => [state, services.filter((service) => service.hosting_state === state).length]));
    return { total: services.length, states, generatedAt: new Date().toISOString() };
  }

  createService(service, actor) {
    const timestamp = nextTimestamp();
    try {
      return this.transaction(() => {
        this.db.prepare(`
          INSERT INTO services(
            service_id,primary_domain,aliases_json,customer_name,contact_email,contact_phone,
            location,provider,hosting_paid_through,domain_paid_through,renewal_months,
            domain_renewal_months,hosting_price_minor,domain_price_minor,currency,grace_days,
            enforcement_mode,manual_state,timezone,notes,source_ref,archived,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          service.service_id, service.primary_domain, JSON.stringify(service.aliases),
          service.customer_name, service.contact_email, service.contact_phone, service.location,
          service.provider, service.hosting_paid_through, service.domain_paid_through,
          service.renewal_months, service.domain_renewal_months, service.hosting_price_minor,
          service.domain_price_minor, service.currency, service.grace_days,
          service.enforcement_mode, service.manual_state, service.timezone, service.notes,
          service.source_ref, Number(service.archived), timestamp, timestamp,
        );
        this.db.prepare(
          "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
        ).run(crypto.randomUUID(), service.service_id, "inventory.created", timestamp, JSON.stringify({
          primaryDomain: service.primary_domain,
        }));
        this.auditEntry(actor, "inventory.create", service.service_id, { after: auditSnapshot(service) });
        return this.service(service.service_id);
      });
    } catch (error) {
      throw databaseConflict(error);
    }
  }

  updateService(serviceId, service, expectedUpdatedAt, actor) {
    const current = this.service(serviceId);
    if (!current) throw Object.assign(new Error("Billing service not found"), { statusCode: 404 });
    if (!expectedUpdatedAt) throw Object.assign(new Error("updated_at precondition is required"), { statusCode: 400 });
    if (current.updated_at !== expectedUpdatedAt) {
      throw Object.assign(new Error("This service changed in another session; reload it before saving"), { statusCode: 409 });
    }
    const timestamp = nextTimestamp(current.updated_at);
    const before = auditSnapshot(current);
    try {
      return this.transaction(() => {
        const result = this.db.prepare(`
          UPDATE services SET
            primary_domain=?,aliases_json=?,customer_name=?,contact_email=?,contact_phone=?,
            location=?,provider=?,hosting_paid_through=?,domain_paid_through=?,renewal_months=?,
            domain_renewal_months=?,hosting_price_minor=?,domain_price_minor=?,currency=?,
            grace_days=?,enforcement_mode=?,manual_state=?,timezone=?,notes=?,source_ref=?,
            updated_at=?
          WHERE service_id=? AND updated_at=?
        `).run(
          service.primary_domain, JSON.stringify(service.aliases), service.customer_name,
          service.contact_email, service.contact_phone, service.location, service.provider,
          service.hosting_paid_through, service.domain_paid_through, service.renewal_months,
          service.domain_renewal_months, service.hosting_price_minor, service.domain_price_minor,
          service.currency, service.grace_days, service.enforcement_mode, service.manual_state,
          service.timezone, service.notes, service.source_ref, timestamp, serviceId, expectedUpdatedAt,
        );
        if (result.changes !== 1) {
          throw Object.assign(new Error("This service changed in another session; reload it before saving"), { statusCode: 409 });
        }
        const updated = this.service(serviceId);
        const after = auditSnapshot(updated);
        const changedFields = Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
        this.db.prepare(
          "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
        ).run(crypto.randomUUID(), serviceId, "inventory.updated", timestamp, JSON.stringify({ changedFields }));
        this.auditEntry(actor, "inventory.update", serviceId, { changedFields, before, after });
        return updated;
      });
    } catch (error) {
      throw databaseConflict(error);
    }
  }

  archiveService(serviceId, archived, expectedUpdatedAt, actor) {
    const current = this.service(serviceId);
    if (!current) throw Object.assign(new Error("Billing service not found"), { statusCode: 404 });
    if (!expectedUpdatedAt) throw Object.assign(new Error("updated_at precondition is required"), { statusCode: 400 });
    if (current.updated_at !== expectedUpdatedAt) {
      throw Object.assign(new Error("This service changed in another session; reload it before saving"), { statusCode: 409 });
    }
    const timestamp = nextTimestamp(current.updated_at);
    return this.transaction(() => {
      const result = this.db.prepare(
        "UPDATE services SET archived=?,updated_at=? WHERE service_id=? AND updated_at=?",
      ).run(Number(Boolean(archived)), timestamp, serviceId, expectedUpdatedAt);
      if (result.changes !== 1) {
        throw Object.assign(new Error("This service changed in another session; reload it before saving"), { statusCode: 409 });
      }
      const action = archived ? "inventory.archive" : "inventory.restore";
      this.db.prepare(
        "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
      ).run(crypto.randomUUID(), serviceId, action, timestamp, "{}");
      this.auditEntry(actor, action, serviceId, { primaryDomain: current.primary_domain });
      return this.service(serviceId);
    });
  }

  applyManualAction(serviceId, action, reason, expectedUpdatedAt, actor) {
    const manualState = MANUAL_ACTIONS[String(action || "")];
    if (manualState === undefined) {
      throw Object.assign(new Error("Unsupported manual billing action"), { statusCode: 400 });
    }
    const boundedReason = String(reason || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
    if (boundedReason.length < 3) {
      throw Object.assign(new Error("A reason of at least 3 characters is required"), { statusCode: 400 });
    }
    const current = this.service(serviceId);
    if (!current) throw Object.assign(new Error("Billing service not found"), { statusCode: 404 });
    if (current.archived) {
      throw Object.assign(new Error("Restore the archived service before changing its state"), { statusCode: 409 });
    }
    if (!expectedUpdatedAt) {
      throw Object.assign(new Error("updated_at precondition is required"), { statusCode: 400 });
    }
    if (current.updated_at !== expectedUpdatedAt) {
      throw Object.assign(new Error("This service changed in another session; reload it before applying an action"), {
        statusCode: 409,
      });
    }
    const timestamp = nextTimestamp(current.updated_at);
    return this.transaction(() => {
      const result = this.db.prepare(
        "UPDATE services SET manual_state=?,updated_at=? WHERE service_id=? AND updated_at=?",
      ).run(manualState, timestamp, serviceId, expectedUpdatedAt);
      if (result.changes !== 1) {
        throw Object.assign(new Error("This service changed in another session; reload it before applying an action"), {
          statusCode: 409,
        });
      }
      const eventType = `inventory.manual_${action}`;
      this.db.prepare(
        "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
      ).run(crypto.randomUUID(), serviceId, eventType, timestamp, JSON.stringify({
        before: current.manual_state,
        after: manualState,
        reason: boundedReason,
      }));
      this.auditEntry(actor, eventType, serviceId, {
        primaryDomain: current.primary_domain,
        before: current.manual_state,
        after: manualState,
        reason: boundedReason,
      });
      return this.service(serviceId);
    });
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
          domain_renewal_months,hosting_price_minor,domain_price_minor,currency,grace_days,
          enforcement_mode,manual_state,timezone,notes,source_ref,archived,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(service_id) DO UPDATE SET
          primary_domain=excluded.primary_domain,aliases_json=excluded.aliases_json,
          customer_name=excluded.customer_name,contact_email=excluded.contact_email,
          contact_phone=excluded.contact_phone,location=excluded.location,provider=excluded.provider,
          hosting_paid_through=excluded.hosting_paid_through,domain_paid_through=excluded.domain_paid_through,
          renewal_months=excluded.renewal_months,domain_renewal_months=excluded.domain_renewal_months,
          hosting_price_minor=excluded.hosting_price_minor,
          domain_price_minor=excluded.domain_price_minor,currency=excluded.currency,
          grace_days=excluded.grace_days,enforcement_mode=excluded.enforcement_mode,
          manual_state=excluded.manual_state,timezone=excluded.timezone,notes=excluded.notes,
          source_ref=excluded.source_ref,archived=excluded.archived,updated_at=excluded.updated_at
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
          service.renewal_months, service.domain_renewal_months, service.hosting_price_minor, service.domain_price_minor,
          service.currency, service.grace_days, service.enforcement_mode, service.manual_state,
          service.timezone, service.notes, service.source_ref, Number(service.archived),
          existing?.created_at || timestamp, timestamp,
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

  createPayment(payment, actor) {
    const timestamp = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO payments(
          payment_id,service_id,token_hash,nonce,woo_order_id,checkout_url,
          amount_minor,currency,months,resulting_paid_through,selection,hosting_months,
          domain_months,resulting_hosting_paid_through,resulting_domain_paid_through,
          status,expires_at,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?)
      `).run(
        payment.paymentId, payment.serviceId, payment.tokenHash, payment.nonce,
        payment.wooOrderId, payment.checkoutUrl, payment.amountMinor, payment.currency,
        payment.months, payment.resultingPaidThrough, payment.selection,
        payment.hostingMonths, payment.domainMonths, payment.resultingHostingPaidThrough,
        payment.resultingDomainPaidThrough, payment.expiresAt, timestamp,
      );
      this.db.prepare(
        "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
      ).run(crypto.randomUUID(), payment.serviceId, "payment.link_created", timestamp, JSON.stringify({
        paymentId: payment.paymentId,
        wooOrderId: payment.wooOrderId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        selection: payment.selection,
        expiresAt: payment.expiresAt,
      }));
      this.auditEntry(actor, "payment.link_create", payment.serviceId, {
        paymentId: payment.paymentId,
        wooOrderId: payment.wooOrderId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        selection: payment.selection,
        expiresAt: payment.expiresAt,
      });
    });
  }

  activePayment(serviceId, selection = "", now = new Date()) {
    this.db.prepare("UPDATE payments SET status='expired' WHERE status='pending' AND expires_at<=?")
      .run(now.toISOString());
    return selection
      ? this.db.prepare(
        "SELECT payment_id,woo_order_id,expires_at,selection FROM payments WHERE service_id=? AND selection=? AND status='pending' ORDER BY created_at DESC LIMIT 1",
      ).get(serviceId, selection) || null
      : this.db.prepare(
        "SELECT payment_id,woo_order_id,expires_at,selection FROM payments WHERE service_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1",
      ).get(serviceId) || null;
  }

  payment(paymentId) {
    return this.db.prepare(`
      SELECT p.payment_id,p.service_id,s.primary_domain,p.woo_order_id,p.amount_minor,
             p.currency,p.months,p.resulting_paid_through,p.status,p.expires_at,
             p.paid_at,p.created_at,p.selection,p.hosting_months,p.domain_months,
             p.resulting_hosting_paid_through,p.resulting_domain_paid_through,
             p.review_required,p.review_reason,p.review_opened_at,p.review_resolved_at,
             s.hosting_paid_through,s.domain_paid_through,
             s.hosting_price_minor AS service_hosting_price_minor,
             s.domain_price_minor AS service_domain_price_minor
      FROM payments p JOIN services s ON s.service_id=p.service_id
      WHERE p.payment_id=?
    `).get(String(paymentId || "")) || null;
  }

  latestPayment(serviceId, selection) {
    return this.db.prepare(`
      SELECT payment_id,service_id,woo_order_id,status,selection,expires_at,created_at
      FROM payments
      WHERE service_id=? AND selection=?
      ORDER BY created_at DESC LIMIT 1
    `).get(serviceId, selection) || null;
  }

  cancelPayment(paymentId, reason, actor) {
    const boundedReason = String(reason || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
    if (boundedReason.length < 3) {
      throw Object.assign(new Error("A cancellation reason of at least 3 characters is required"), { statusCode: 400 });
    }
    const payment = this.payment(paymentId);
    if (!payment) throw Object.assign(new Error("Payment record was not found"), { statusCode: 404 });
    if (payment.status !== "pending") {
      throw Object.assign(new Error("Only a pending payment can be cancelled"), { statusCode: 409 });
    }
    const timestamp = new Date().toISOString();
    return this.transaction(() => {
      const result = this.db.prepare(
        "UPDATE payments SET status='cancelled' WHERE payment_id=? AND status='pending'",
      ).run(payment.payment_id);
      if (result.changes !== 1) {
        throw Object.assign(new Error("Payment state changed before cancellation completed"), { statusCode: 409 });
      }
      this.db.prepare(
        "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
      ).run(crypto.randomUUID(), payment.service_id, "payment.cancelled", timestamp, JSON.stringify({
        paymentId: payment.payment_id,
        wooOrderId: payment.woo_order_id,
        reason: boundedReason,
      }));
      this.auditEntry(actor, "payment.cancel", payment.service_id, {
        paymentId: payment.payment_id,
        wooOrderId: payment.woo_order_id,
        reason: boundedReason,
      });
      return this.payment(payment.payment_id);
    });
  }

  cancelExpiredPayment(paymentId, reason, actor) {
    const payment = this.payment(paymentId);
    if (!payment) throw Object.assign(new Error("Payment record was not found"), { statusCode: 404 });
    if (payment.status !== "expired") {
      throw Object.assign(new Error("Only an expired payment can be retired"), { statusCode: 409 });
    }
    const timestamp = new Date().toISOString();
    return this.transaction(() => {
      const result = this.db.prepare(
        "UPDATE payments SET status='cancelled' WHERE payment_id=? AND status='expired'",
      ).run(payment.payment_id);
      if (result.changes !== 1) {
        throw Object.assign(new Error("Payment state changed before refresh completed"), { statusCode: 409 });
      }
      this.db.prepare(
        "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
      ).run(crypto.randomUUID(), payment.service_id, "payment.expired_order_cancelled", timestamp, JSON.stringify({
        paymentId: payment.payment_id,
        wooOrderId: payment.woo_order_id,
        reason,
      }));
      this.auditEntry(actor, "payment.expired_order_cancel", payment.service_id, {
        paymentId: payment.payment_id,
        wooOrderId: payment.woo_order_id,
        reason,
      });
      return this.payment(payment.payment_id);
    });
  }

  payments(limit = 100) {
    return this.db.prepare(`
      SELECT p.payment_id,p.service_id,s.primary_domain,p.woo_order_id,p.amount_minor,
             p.currency,p.months,p.resulting_paid_through,p.status,p.expires_at,
             p.paid_at,p.created_at,p.selection,p.hosting_months,p.domain_months,
             p.resulting_hosting_paid_through,p.resulting_domain_paid_through,
             p.review_required,p.review_reason,p.review_opened_at,p.review_resolved_at,
             s.hosting_paid_through,s.domain_paid_through,
             s.hosting_price_minor AS service_hosting_price_minor,
             s.domain_price_minor AS service_domain_price_minor
      FROM payments p JOIN services s ON s.service_id=p.service_id
      ORDER BY p.created_at DESC LIMIT ?
    `).all(Math.min(500, Math.max(1, Number(limit) || 100)));
  }

  publicPayments(serviceId, now = new Date()) {
    this.db.prepare("UPDATE payments SET status='expired' WHERE status='pending' AND expires_at<=?")
      .run(now.toISOString());
    return this.db.prepare(`
      SELECT payment_id,selection,amount_minor,currency,hosting_months,domain_months,
             resulting_hosting_paid_through,resulting_domain_paid_through,expires_at
      FROM payments
      WHERE service_id=? AND status='pending'
      ORDER BY created_at DESC
    `).all(serviceId);
  }

  resolvePublicPayment(serviceId, paymentId, now = new Date()) {
    const payment = this.db.prepare(
      "SELECT payment_id,checkout_url,status,expires_at FROM payments WHERE payment_id=? AND service_id=?",
    ).get(paymentId, serviceId);
    if (!payment) throw Object.assign(new Error("Payment option was not found"), { statusCode: 404 });
    if (payment.status !== "pending" || Date.parse(payment.expires_at) <= now.valueOf()) {
      if (payment.status === "pending") {
        this.db.prepare("UPDATE payments SET status='expired' WHERE payment_id=?").run(payment.payment_id);
      }
      throw Object.assign(new Error("Payment option is no longer active"), { statusCode: 410 });
    }
    return payment.checkout_url;
  }

  resolvePayment(hash, now = new Date()) {
    const payment = this.db.prepare(
      "SELECT payment_id,checkout_url,status,expires_at FROM payments WHERE token_hash=?",
    ).get(hash);
    if (!payment) throw Object.assign(new Error("Payment link was not found"), { statusCode: 404 });
    if (payment.status !== "pending") throw Object.assign(new Error("Payment link is no longer active"), { statusCode: 410 });
    if (Date.parse(payment.expires_at) <= now.valueOf()) {
      this.db.prepare("UPDATE payments SET status='expired' WHERE payment_id=? AND status='pending'").run(payment.payment_id);
      throw Object.assign(new Error("Payment link has expired"), { statusCode: 410 });
    }
    return payment.checkout_url;
  }

  resolvePaymentReview(paymentId, reason, actor) {
    const boundedReason = String(reason || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
    if (boundedReason.length < 3) {
      throw Object.assign(new Error("A review resolution reason of at least 3 characters is required"), {
        statusCode: 400,
      });
    }
    const payment = this.payment(paymentId);
    if (!payment) throw Object.assign(new Error("Payment record was not found"), { statusCode: 404 });
    if (!payment.review_required) {
      throw Object.assign(new Error("This payment no longer requires review"), { statusCode: 409 });
    }
    const timestamp = new Date().toISOString();
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE payments
        SET review_required=0,review_resolved_at=?
        WHERE payment_id=? AND review_required=1
      `).run(timestamp, payment.payment_id);
      if (result.changes !== 1) {
        throw Object.assign(new Error("Payment review state changed before resolution completed"), {
          statusCode: 409,
        });
      }
      this.db.prepare(
        "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
      ).run(crypto.randomUUID(), payment.service_id, "payment.review_resolved", timestamp, JSON.stringify({
        paymentId: payment.payment_id,
        wooOrderId: payment.woo_order_id,
        reviewReason: payment.review_reason,
        resolution: boundedReason,
      }));
      this.auditEntry(actor, "payment.review_resolve", payment.service_id, {
        paymentId: payment.payment_id,
        wooOrderId: payment.woo_order_id,
        reviewReason: payment.review_reason,
        resolution: boundedReason,
      });
      return this.payment(payment.payment_id);
    });
  }

  processWebhook(delivery) {
    return this.transaction(() => {
      const duplicate = this.db.prepare("SELECT result FROM webhook_deliveries WHERE delivery_id=?").get(delivery.deliveryId);
      if (duplicate) return { duplicate: true, result: duplicate.result };
      const payment = this.db.prepare("SELECT * FROM payments WHERE woo_order_id=?").get(delivery.resourceId);
      let result = "ignored";
      const timestamp = new Date().toISOString();
      const requireReview = (reason, disablePending = false) => {
        this.db.prepare(`
          UPDATE payments
          SET review_required=1,review_reason=?,review_opened_at=?,
              review_resolved_at='',status=CASE WHEN ?=1 AND status='pending' THEN 'review' ELSE status END
          WHERE payment_id=?
        `).run(reason, timestamp, Number(disablePending), payment.payment_id);
      };
      if (payment && ["processing", "completed"].includes(delivery.status)) {
        if (delivery.totalMinor !== payment.amount_minor || delivery.currency !== payment.currency) {
          requireReview(
            `WooCommerce reported ${delivery.totalMinor} ${delivery.currency || "unknown"}; expected `
              + `${payment.amount_minor} ${payment.currency}`,
            true,
          );
          result = "amount_mismatch";
        } else if (payment.status === "paid") {
          result = "already_paid";
        } else if (payment.status !== "pending") {
          this.db.prepare(
            "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
          ).run(crypto.randomUUID(), payment.service_id, "payment.late_completion", timestamp, JSON.stringify({
            paymentId: payment.payment_id,
            wooOrderId: payment.woo_order_id,
            priorStatus: payment.status,
            reviewRequired: true,
          }));
          requireReview(`WooCommerce reported ${delivery.status} after local payment status ${payment.status}`);
          result = "review_required";
        } else {
          this.db.prepare("UPDATE payments SET status='paid',paid_at=? WHERE payment_id=?")
            .run(timestamp, payment.payment_id);
          if (payment.selection === "hosting") {
            this.db.prepare("UPDATE services SET hosting_paid_through=?,updated_at=? WHERE service_id=?")
              .run(payment.resulting_hosting_paid_through, timestamp, payment.service_id);
          } else if (payment.selection === "domain") {
            this.db.prepare("UPDATE services SET domain_paid_through=?,updated_at=? WHERE service_id=?")
              .run(payment.resulting_domain_paid_through, timestamp, payment.service_id);
          } else if (payment.selection === "both") {
            this.db.prepare(
              "UPDATE services SET hosting_paid_through=?,domain_paid_through=?,updated_at=? WHERE service_id=?",
            ).run(
              payment.resulting_hosting_paid_through,
              payment.resulting_domain_paid_through,
              timestamp,
              payment.service_id,
            );
          } else {
            throw new Error("Stored payment selection is invalid");
          }
          this.db.prepare(
            "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
          ).run(crypto.randomUUID(), payment.service_id, "payment.completed", timestamp, JSON.stringify({
            paymentId: payment.payment_id,
            wooOrderId: payment.woo_order_id,
            amountMinor: payment.amount_minor,
            currency: payment.currency,
            selection: payment.selection,
            resultingHostingPaidThrough: payment.resulting_hosting_paid_through,
            resultingDomainPaidThrough: payment.resulting_domain_paid_through,
          }));
          result = "paid";
        }
      } else if (payment && ["refunded", "cancelled", "failed"].includes(delivery.status)) {
        const expectedCancellation = delivery.status === "cancelled" && payment.status === "cancelled";
        this.db.prepare(
          "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
        ).run(crypto.randomUUID(), payment.service_id, `payment.${delivery.status}`, timestamp, JSON.stringify({
          paymentId: payment.payment_id,
          wooOrderId: payment.woo_order_id,
          reviewRequired: !expectedCancellation,
        }));
        if (expectedCancellation) {
          result = "cancel_confirmed";
        } else {
          requireReview(`WooCommerce reported ${delivery.status} after local payment status ${payment.status}`, true);
          result = "review_required";
        }
      }
      this.db.prepare(
        "INSERT INTO webhook_deliveries(delivery_id,topic,resource_id,result,created_at) VALUES(?,?,?,?,?)",
      ).run(delivery.deliveryId, delivery.topic, delivery.resourceId, result, timestamp);
      this.auditEntry("woocommerce-webhook", "payment.webhook", String(delivery.resourceId), {
        deliveryId: delivery.deliveryId,
        topic: delivery.topic,
        status: delivery.status,
        result,
      });
      return { duplicate: false, result };
    });
  }

  dueReminders(now = new Date()) {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return this.services({ now }).filter((service) =>
      service.hosting_paid_through && ["reminder", "grace", "suspended"].includes(service.hosting_state))
      .map((service) => {
        const paid = Date.parse(`${service.hosting_paid_through}T00:00:00Z`);
        const state = service.hosting_state;
        const reminderKey = crypto.createHash("sha256")
          .update(`${service.service_id}\n${service.hosting_paid_through}\n${state}`).digest("hex");
        const existing = this.db.prepare("SELECT status,attempts,error,sent_at FROM reminder_outbox WHERE reminder_key=?")
          .get(reminderKey);
        return {
          reminder_key: reminderKey,
          service_id: service.service_id,
          domain: service.primary_domain,
          state,
          paid_through: service.hosting_paid_through,
          days_remaining: Math.floor((paid - today) / 86_400_000),
          delivery_status: existing?.status || "new",
          attempts: Number(existing?.attempts || 0),
          error: existing?.error || "",
          sent_at: existing?.sent_at || "",
        };
      });
  }

  queueReminders(reminders) {
    const timestamp = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO reminder_outbox(
        reminder_key,service_id,state,paid_through,days_remaining,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,'pending',?,?)
    `);
    for (const item of reminders) {
      insert.run(
        item.reminder_key, item.service_id, item.state, item.paid_through,
        item.days_remaining, timestamp, timestamp,
      );
    }
    return this.db.prepare(`
      SELECT o.*,s.primary_domain AS domain
      FROM reminder_outbox o JOIN services s ON s.service_id=o.service_id
      WHERE o.reminder_key IN (${reminders.map(() => "?").join(",") || "NULL"})
        AND o.status IN ('pending','failed')
      ORDER BY o.created_at
    `).all(...reminders.map((item) => item.reminder_key));
  }

  markReminder(reminderKey, result) {
    const timestamp = new Date().toISOString();
    if (result.ok) {
      this.db.prepare(`
        UPDATE reminder_outbox
        SET status='sent',attempts=attempts+1,error='',remote_delivery_id=?,sent_at=?,updated_at=?
        WHERE reminder_key=?
      `).run(String(result.deliveryId || "").slice(0, 160), timestamp, timestamp, reminderKey);
    } else {
      this.db.prepare(`
        UPDATE reminder_outbox
        SET status='failed',attempts=attempts+1,error=?,updated_at=?
        WHERE reminder_key=?
      `).run(String(result.error || "Notification delivery failed").slice(0, 300), timestamp, reminderKey);
    }
  }

  reminderHistory(limit = 100) {
    return this.db.prepare(`
      SELECT o.reminder_key,o.service_id,s.primary_domain AS domain,o.state,o.paid_through,
             o.days_remaining,o.status,o.attempts,o.error,o.created_at,o.sent_at
      FROM reminder_outbox o JOIN services s ON s.service_id=o.service_id
      ORDER BY o.created_at DESC LIMIT ?
    `).all(Math.min(500, Math.max(1, Number(limit) || 100)));
  }

  enrollmentActive(service) {
    return service && !service.archived && service.location === "shared";
  }

  createEnrollmentCode({ serviceId, canonicalDomain, expiresInHours, actor }) {
    const service = this.service(serviceId);
    if (!service) throw Object.assign(new Error("Billing service was not found"), { statusCode: 404 });
    if (service.archived) throw Object.assign(new Error("Billing service is archived"), { statusCode: 409 });
    if (!this.enrollmentActive(service)) {
      throw Object.assign(
        new Error("Enrollment is available only for remote/shared-hosting WordPress services"),
        { statusCode: 400 },
      );
    }
    const target = domain(canonicalDomain);
    if (target !== service.primary_domain) {
      throw Object.assign(new Error("Enrollment target must be the service's canonical domain"), { statusCode: 400 });
    }
    const now = new Date().toISOString();
    const activeInstallation = this.db.prepare(
      "SELECT 1 FROM wp_installations WHERE service_id=? AND canonical_domain=? AND credential_revoked_at=''",
    ).get(service.service_id, target);
    if (activeInstallation) {
      throw Object.assign(new Error("An active installation already exists for this service"), { statusCode: 409 });
    }
    const pendingCode = this.db.prepare(
      "SELECT 1 FROM enrollment_codes WHERE service_id=? AND canonical_domain=? AND used_at='' AND revoked_at='' AND expires_at>?",
    ).get(service.service_id, target, now);
    if (pendingCode) {
      throw Object.assign(new Error("A pending enrollment code already exists for this service"), { statusCode: 409 });
    }
    const hours = integer(expiresInHours, 1, 168, 24);
    const codeId = crypto.randomUUID();
    const code = crypto.randomBytes(24).toString("base64url");
    const codeHash = enrollmentHash(code);
    const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();
    const createdBy = bounded(actor, 160);
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO enrollment_codes(code_id,code_hash,service_id,canonical_domain,expires_at,created_at,created_by)
        VALUES(?,?,?,?,?,?,?)
      `).run(codeId, codeHash, service.service_id, target, expiresAt, now, createdBy);
    });
    this.auditEntry(createdBy || "admin", "enrollment.code_created", codeId, {
      serviceId: service.service_id,
      domain: target,
      expiresAt,
    });
    return { codeId, code, expiresAt };
  }

  exchangeEnrollmentCode({ code, domain: claimedDomain }) {
    const codeHash = enrollmentHash(code);
    const now = new Date().toISOString();
    let result = null;
    let rejected = null;
    this.transaction(() => {
      const row = this.db.prepare(
        "SELECT code_id,code_hash,service_id,canonical_domain,expires_at,used_at,revoked_at FROM enrollment_codes WHERE code_hash=?",
      ).get(codeHash);
      if (!row) {
        rejected = { statusCode: 404, message: "Enrollment code is invalid" };
        return;
      }
      if (row.used_at) {
        rejected = { statusCode: 409, message: "Enrollment code was already used" };
        return;
      }
      if (row.revoked_at) {
        rejected = { statusCode: 409, message: "Enrollment code was revoked" };
        return;
      }
      if (!row.expires_at || row.expires_at <= now) {
        rejected = { statusCode: 410, message: "Enrollment code has expired" };
        return;
      }
      const service = this.service(row.service_id);
      if (!service) {
        rejected = { statusCode: 404, message: "Billing service was not found" };
        return;
      }
      if (service.archived) {
        rejected = { statusCode: 409, message: "Billing service is archived" };
        return;
      }
      if (!this.enrollmentActive(service)) {
        rejected = { statusCode: 400, message: "Enrollment is not available for this service" };
        return;
      }
      const target = domain(claimedDomain);
      if (target !== row.canonical_domain) {
        rejected = { statusCode: 400, message: "Domain does not match this enrollment" };
        return;
      }
      const activeInstallation = this.db.prepare(
        "SELECT 1 FROM wp_installations WHERE service_id=? AND canonical_domain=? AND credential_revoked_at=''",
      ).get(row.service_id, target);
      if (activeInstallation) {
        rejected = { statusCode: 409, message: "An active installation already exists for this service" };
        return;
      }
      const installationId = crypto.randomUUID();
      const credential = crypto.randomBytes(32).toString("base64url");
      const credentialHash = enrollmentHash(credential);
      this.db.prepare(`
        INSERT INTO wp_installations(
          installation_id,service_id,canonical_domain,credential_hash,credential_created_at,
          enrollment_code_id,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?)
      `).run(installationId, row.service_id, target, credentialHash, now, row.code_id, now, now);
      const consumed = this.db.prepare(
        "UPDATE enrollment_codes SET used_at=?, used_by_installation_id=? WHERE code_id=? AND used_at=''",
      ).run(now, installationId, row.code_id);
      if (consumed.changes !== 1) {
        throw Object.assign(new Error("Enrollment code was already used"), { statusCode: 409 });
      }
      result = { installationId, credential, serviceId: row.service_id, canonicalDomain: target };
    });
    if (rejected) {
      this.auditEntry("system", "enrollment.exchange_rejected", String(codeHash).slice(0, 16), {
        reason: bounded(rejected.message, 120),
      });
      throw Object.assign(new Error(rejected.message), { statusCode: rejected.statusCode });
    }
    if (result) {
      this.auditEntry("system", "enrollment.exchanged", result.installationId, {
        serviceId: result.serviceId,
        canonicalDomain: result.canonicalDomain,
      });
      return { installationId: result.installationId, credential: result.credential };
    }
    throw Object.assign(new Error("Enrollment could not be completed"), { statusCode: 500 });
  }

  revokeEnrollmentCode(codeId, actor) {
    const row = this.db.prepare("SELECT code_id FROM enrollment_codes WHERE code_id=?").get(String(codeId || ""));
    if (!row) throw Object.assign(new Error("Enrollment code was not found"), { statusCode: 404 });
    this.db.prepare("UPDATE enrollment_codes SET revoked_at=? WHERE code_id=? AND revoked_at=''")
      .run(new Date().toISOString(), row.code_id);
    this.auditEntry(bounded(actor, 160) || "admin", "enrollment.code_revoked", row.code_id, {});
    return { codeId: row.code_id };
  }

  revokeInstallationCredential(installationId, actor) {
    const row = this.db.prepare("SELECT installation_id FROM wp_installations WHERE installation_id=?")
      .get(String(installationId || ""));
    if (!row) throw Object.assign(new Error("Installation was not found"), { statusCode: 404 });
    this.db.prepare("UPDATE wp_installations SET credential_revoked_at=?, updated_at=? WHERE installation_id=? AND credential_revoked_at=''")
      .run(new Date().toISOString(), new Date().toISOString(), row.installation_id);
    this.auditEntry(bounded(actor, 160) || "admin", "enrollment.installation_revoked", row.installation_id, {});
    return { installationId: row.installation_id };
  }

  listInstallationsForService(serviceId, limit = 50) {
    return this.db.prepare(`
      SELECT installation_id, service_id, canonical_domain, credential_created_at,
             credential_revoked_at, created_at, updated_at
      FROM wp_installations WHERE service_id=? ORDER BY created_at LIMIT ?
    `).all(String(serviceId || ""), Math.min(500, Math.max(1, Number(limit) || 50)));
  }

  getInstallationHealth(installationId) {
    return this.db.prepare(`
      SELECT installation_id, service_id, canonical_domain, credential_created_at,
             credential_revoked_at, created_at, updated_at,
             last_seen_at, last_success_at, contract_version, safe_status
      FROM wp_installations WHERE installation_id=?
    `).get(String(installationId || "")) || null;
  }

  // --- signing keys ---

  activeSigningKeyRaw() {
    return this.db.prepare(
      "SELECT key_id, public_key, private_key_encrypted, is_active FROM signing_keys WHERE is_active=1 LIMIT 1",
    ).get() || null;
  }

  activePublicKey() {
    const row = this.activeSigningKeyRaw();
    if (!row) return null;
    return { keyId: row.key_id, publicKey: row.public_key };
  }

  allPublicKeys() {
    return this.db.prepare(
      "SELECT key_id, public_key, created_at, expires_at, rotated_at FROM signing_keys ORDER BY created_at",
    ).all();
  }

  signingKeyStatus() {
    const active = this.activeSigningKeyRaw();
    const keys = this.db.prepare(
      "SELECT key_id, public_key, is_active, created_at, expires_at, rotated_at, retired_at, overlap_hours FROM signing_keys ORDER BY created_at DESC",
    ).all();
    return {
      configured: Boolean(active),
      active: active ? { keyId: active.key_id, publicKey: active.public_key } : null,
      keys: keys.map((k) => ({
        keyId: k.key_id,
        publicKey: k.public_key,
        active: Boolean(k.is_active),
        createdAt: k.created_at,
        expiresAt: k.expires_at,
        rotatedAt: k.rotated_at,
        retiredAt: k.retired_at,
      })),
    };
  }

  initSigningKey(keyId, publicKey, privateKeyEncrypted, expiresAt, overlapHours, actor) {
    const existing = this.activeSigningKeyRaw();
    if (existing) throw Object.assign(new Error("A signing key is already active; use rotation"), { statusCode: 409 });
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO signing_keys(key_id,public_key,private_key_encrypted,is_active,created_at,expires_at,overlap_hours,created_by)
        VALUES(?,?,?,1,?,?,?,?)
      `).run(keyId, publicKey, privateKeyEncrypted, now, expiresAt, overlapHours, bounded(actor, 160));
    });
    this.auditEntry(bounded(actor, 160) || "admin", "signing.key_initialized", keyId, { keyId });
    return keyId;
  }

  rotateSigningKey(keyId, publicKey, privateKeyEncrypted, expiresAt, overlapHours, actor) {
    const active = this.activeSigningKeyRaw();
    if (!active) throw Object.assign(new Error("No active signing key exists; use initialize"), { statusCode: 400 });
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(
        "UPDATE signing_keys SET is_active=0, rotated_at=? WHERE key_id=? AND is_active=1",
      ).run(now, active.key_id);
      this.db.prepare(
        "DELETE FROM signing_keys WHERE is_active=0 AND rotated_at != '' AND retired_at != '' AND datetime(rotated_at, ? || ' hours') <= datetime('now')",
      ).run(String(overlapHours || 720));
      this.db.prepare(`
        INSERT INTO signing_keys(key_id,public_key,private_key_encrypted,is_active,created_at,expires_at,overlap_hours,created_by)
        VALUES(?,?,?,1,?,?,?,?)
      `).run(keyId, publicKey, privateKeyEncrypted, now, expiresAt, overlapHours, bounded(actor, 160));
    });
    this.auditEntry(bounded(actor, 160) || "admin", "signing.key_rotated", keyId, { previousKeyId: active.key_id, keyId });
    return keyId;
  }

  retireSigningKey(keyId, emergency, actor) {
    const key = this.db.prepare("SELECT key_id, is_active, rotated_at, expires_at FROM signing_keys WHERE key_id=?")
      .get(String(keyId || ""));
    if (!key) throw Object.assign(new Error("Signing key was not found"), { statusCode: 404 });
    if (key.is_active) throw Object.assign(new Error("Cannot retire the active key; rotate first"), { statusCode: 409 });
    if (key.retired_at) throw Object.assign(new Error("Signing key is already retired"), { statusCode: 409 });
    if (!emergency && key.expires_at && key.expires_at > new Date().toISOString()) {
      throw Object.assign(
        new Error("Key overlap has not expired; use emergency confirmation to retire early"),
        { statusCode: 409 },
      );
    }
    this.db.prepare("UPDATE signing_keys SET retired_at=? WHERE key_id=?")
      .run(new Date().toISOString(), key.key_id);
    this.auditEntry(bounded(actor, 160) || "admin", "signing.key_retired", keyId, { keyId, emergency });
    return key.key_id;
  }

  // --- heartbeat ---

  heartbeatInstallation(installationId, success) {
    const HEARTBEAT_MIN_MS = 60_000;
    const now = new Date().toISOString();
    const install = this.getInstallationHealth(installationId);
    if (!install) return null;
    const lastSeen = Date.parse(install.last_seen_at || "");
    const shouldWrite = !lastSeen || !Number.isFinite(lastSeen) || (Date.now() - lastSeen >= HEARTBEAT_MIN_MS);
    if (shouldWrite) {
      const updates = ["last_seen_at=?", "updated_at=?"];
      const params = [now, now];
      if (success) {
        updates.push("last_success_at=?");
        params.push(now);
      }
      this.db.prepare(
        `UPDATE wp_installations SET ${updates.join(",")} WHERE installation_id=?`,
      ).run(...params, installationId);
    }
    return this.getInstallationHealth(installationId);
  }

  // --- installation authentication ---

  authenticateInstallation(installationId, credential) {
    if (!installationId || !credential) return null;
    const hash = enrollmentHash(credential);
    const installation = this.db.prepare(
      "SELECT installation_id, service_id, canonical_domain, credential_revoked_at FROM wp_installations WHERE credential_hash=?",
    ).get(hash);
    if (!installation) return null;
    if (installation.installation_id !== installationId) return null;
    if (installation.credential_revoked_at) return null;
    const service = this.service(installation.service_id);
    if (!service || service.archived) return null;
    if (!this.enrollmentActive(service)) return null;
    return installation;
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

module.exports = { BillingDatabase, SCHEMA_VERSION, enrollmentHash, rowView };
