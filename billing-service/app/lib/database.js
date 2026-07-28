const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { stateForDate } = require("./validation");

const SCHEMA_VERSION = 3;

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

  service(serviceId) {
    const row = this.db.prepare("SELECT * FROM services WHERE service_id=?").get(String(serviceId || ""));
    return row ? rowView(row, this.reminderDays()) : null;
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

  createPayment(payment, actor) {
    const timestamp = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO payments(
          payment_id,service_id,token_hash,nonce,woo_order_id,checkout_url,
          amount_minor,currency,months,resulting_paid_through,status,expires_at,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?, 'pending',?,?)
      `).run(
        payment.paymentId, payment.serviceId, payment.tokenHash, payment.nonce,
        payment.wooOrderId, payment.checkoutUrl, payment.amountMinor, payment.currency,
        payment.months, payment.resultingPaidThrough, payment.expiresAt, timestamp,
      );
      this.db.prepare(
        "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
      ).run(crypto.randomUUID(), payment.serviceId, "payment.link_created", timestamp, JSON.stringify({
        paymentId: payment.paymentId,
        wooOrderId: payment.wooOrderId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        expiresAt: payment.expiresAt,
      }));
      this.auditEntry(actor, "payment.link_create", payment.serviceId, {
        paymentId: payment.paymentId,
        wooOrderId: payment.wooOrderId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        expiresAt: payment.expiresAt,
      });
    });
  }

  activePayment(serviceId, now = new Date()) {
    this.db.prepare("UPDATE payments SET status='expired' WHERE status='pending' AND expires_at<=?")
      .run(now.toISOString());
    return this.db.prepare(
      "SELECT payment_id,woo_order_id,expires_at FROM payments WHERE service_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1",
    ).get(serviceId) || null;
  }

  payments(limit = 100) {
    return this.db.prepare(`
      SELECT p.payment_id,p.service_id,s.primary_domain,p.woo_order_id,p.amount_minor,
             p.currency,p.months,p.resulting_paid_through,p.status,p.expires_at,
             p.paid_at,p.created_at
      FROM payments p JOIN services s ON s.service_id=p.service_id
      ORDER BY p.created_at DESC LIMIT ?
    `).all(Math.min(500, Math.max(1, Number(limit) || 100)));
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

  processWebhook(delivery) {
    return this.transaction(() => {
      const duplicate = this.db.prepare("SELECT result FROM webhook_deliveries WHERE delivery_id=?").get(delivery.deliveryId);
      if (duplicate) return { duplicate: true, result: duplicate.result };
      const payment = this.db.prepare("SELECT * FROM payments WHERE woo_order_id=?").get(delivery.resourceId);
      let result = "ignored";
      const timestamp = new Date().toISOString();
      if (payment && ["processing", "completed"].includes(delivery.status)) {
        if (delivery.totalMinor !== payment.amount_minor || delivery.currency !== payment.currency) {
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
          result = "review_required";
        } else {
          this.db.prepare("UPDATE payments SET status='paid',paid_at=? WHERE payment_id=?")
            .run(timestamp, payment.payment_id);
          this.db.prepare("UPDATE services SET hosting_paid_through=?,updated_at=? WHERE service_id=?")
            .run(payment.resulting_paid_through, timestamp, payment.service_id);
          this.db.prepare(
            "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
          ).run(crypto.randomUUID(), payment.service_id, "payment.completed", timestamp, JSON.stringify({
            paymentId: payment.payment_id,
            wooOrderId: payment.woo_order_id,
            amountMinor: payment.amount_minor,
            currency: payment.currency,
            resultingPaidThrough: payment.resulting_paid_through,
          }));
          result = "paid";
        }
      } else if (payment && ["refunded", "cancelled", "failed"].includes(delivery.status)) {
        this.db.prepare(
          "INSERT INTO events(event_id,service_id,event_type,happened_at,payload_json) VALUES(?,?,?,?,?)",
        ).run(crypto.randomUUID(), payment.service_id, `payment.${delivery.status}`, timestamp, JSON.stringify({
          paymentId: payment.payment_id,
          wooOrderId: payment.woo_order_id,
          reviewRequired: true,
        }));
        result = "review_required";
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
