class NotificationClient {
  constructor(options = {}) {
    this.url = options.url || process.env.NOTIFICATION_API_URL || "http://hosting-ui:8687/internal/v1/billing-reminders";
    this.token = options.token || process.env.BILLING_API_TOKEN || "";
    this.fetch = options.fetch || global.fetch;
  }

  async send(reminder) {
    const response = await this.fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reminder),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.delivery?.id) {
      throw new Error(String(body.message || `Notification API returned HTTP ${response.status}`).slice(0, 300));
    }
    return body.delivery;
  }
}

function localClock(now = new Date(), timezone = "Europe/Kyiv") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

class ReminderManager {
  constructor(database, client, options = {}) {
    this.database = database;
    this.client = client;
    this.timezone = options.timezone || process.env.TZ || "Europe/Kyiv";
    this.timer = null;
    this.running = false;
  }

  preview(now = new Date()) {
    return this.database.dueReminders(now);
  }

  async run(actor = "scheduler", now = new Date()) {
    if (this.running) throw Object.assign(new Error("A reminder run is already active"), { statusCode: 409 });
    this.running = true;
    try {
      const due = this.preview(now);
      const pending = this.database.queueReminders(due);
      const results = [];
      for (const reminder of pending) {
        try {
          const delivery = await this.client.send(reminder);
          this.database.markReminder(reminder.reminder_key, { ok: true, deliveryId: delivery.id });
          results.push({ domain: reminder.domain, state: reminder.state, ok: true, deliveryId: delivery.id });
        } catch (error) {
          this.database.markReminder(reminder.reminder_key, { ok: false, error: error.message });
          results.push({ domain: reminder.domain, state: reminder.state, ok: false, error: String(error.message).slice(0, 300) });
        }
      }
      this.database.auditEntry(actor, "reminder.run", "hosting", {
        due: due.length,
        attempted: pending.length,
        sent: results.filter((item) => item.ok).length,
        failed: results.filter((item) => !item.ok).length,
      });
      return { due: due.length, attempted: pending.length, results };
    } finally {
      this.running = false;
    }
  }

  async tick(now = new Date()) {
    const settings = this.database.reminderSettings();
    if (!settings.enabled) return null;
    const clock = localClock(now, this.timezone);
    if (clock.time < settings.time || settings.lastRun === clock.date) return null;
    const result = await this.run("scheduler", now);
    this.database.setReminderLastRun(clock.date);
    return result;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => {
      console.error(`Billing reminder scheduler failed: ${String(error.message).slice(0, 300)}`);
    }), 30_000);
    this.timer.unref?.();
    this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { NotificationClient, ReminderManager, localClock };
