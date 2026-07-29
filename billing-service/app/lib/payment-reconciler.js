const { localClock } = require("./reminders");

const DUE_STATES = new Set(["reminder", "grace", "suspended"]);
const RUN_LIMIT = 10;

function overlaps(left, right) {
  if (left === "both" || right === "both") return true;
  return left === right;
}

class PaymentOptionReconciler {
  constructor(database, payments, options = {}) {
    this.database = database;
    this.payments = payments;
    this.timezone = options.timezone || process.env.TZ || "Europe/Kyiv";
    this.timer = null;
    this.running = false;
  }

  preview(now = new Date()) {
    const candidates = [];
    for (const service of this.database.services({ now })) {
      const hostingDue = DUE_STATES.has(service.hosting_state)
        && Boolean(service.hosting_paid_through) && service.hosting_price_minor > 0;
      const domainDue = DUE_STATES.has(service.domain_state)
        && Boolean(service.domain_paid_through) && service.domain_price_minor > 0;
      if (!hostingDue && !domainDue) continue;

      const active = {
        hosting: this.database.activePayment(service.service_id, "hosting", now),
        domain: this.database.activePayment(service.service_id, "domain", now),
        both: this.database.activePayment(service.service_id, "both", now),
      };
      const selections = [];
      if (!active.both) {
        if (hostingDue && domainDue && !active.hosting && !active.domain) selections.push("both");
        else {
          if (hostingDue && !active.hosting) selections.push("hosting");
          if (domainDue && !active.domain) selections.push("domain");
        }
      }
      const latest = ["hosting", "domain", "both"]
        .map((selection) => this.database.latestPayment(service.service_id, selection))
        .filter(Boolean);
      for (const selection of selections) {
        const same = latest.find((payment) => payment.selection === selection);
        const conflictingExpired = latest.find((payment) =>
          payment.status === "expired" && payment.selection !== selection
          && overlaps(payment.selection, selection));
        const action = conflictingExpired ? "blocked" : same?.status === "expired" ? "refresh" : "create";
        candidates.push({
          service_id: service.service_id,
          domain: service.primary_domain,
          selection,
          action,
          reason: conflictingExpired
            ? `Expired ${conflictingExpired.selection} order #${conflictingExpired.woo_order_id} overlaps this option`
            : "",
          amount_minor: selection === "hosting"
            ? service.hosting_price_minor
            : selection === "domain"
              ? service.domain_price_minor
              : service.hosting_price_minor + service.domain_price_minor,
          currency: service.currency,
        });
      }
    }
    return candidates;
  }

  async run(actor = "scheduler", now = new Date()) {
    if (this.running) throw Object.assign(new Error("A payment option run is already active"), { statusCode: 409 });
    this.running = true;
    try {
      const preview = this.preview(now);
      const actionable = preview.filter((item) => item.action !== "blocked");
      const results = [];
      for (const candidate of actionable.slice(0, RUN_LIMIT)) {
        try {
          const payment = candidate.action === "refresh"
            ? await this.payments.refreshExpired(candidate.service_id, candidate.selection, actor)
            : await this.payments.create(candidate.service_id, { selection: candidate.selection }, actor);
          results.push({
            domain: candidate.domain,
            selection: candidate.selection,
            action: candidate.action,
            ok: true,
            orderId: payment.orderId,
          });
        } catch (error) {
          results.push({
            domain: candidate.domain,
            selection: candidate.selection,
            action: candidate.action,
            ok: false,
            error: String(error.message).slice(0, 300),
          });
        }
      }
      this.database.auditEntry(actor, "payment_options.run", "renewals", {
        candidates: preview.length,
        blocked: preview.filter((item) => item.action === "blocked").length,
        deferred: Math.max(0, actionable.length - RUN_LIMIT),
        created: results.filter((item) => item.ok).length,
        failed: results.filter((item) => !item.ok).length,
      });
      return {
        candidates: preview.length,
        blocked: preview.filter((item) => item.action === "blocked").length,
        deferred: Math.max(0, actionable.length - RUN_LIMIT),
        results,
      };
    } finally {
      this.running = false;
    }
  }

  async tick(now = new Date()) {
    const settings = this.database.paymentOptionSettings();
    if (!settings.enabled) return null;
    const clock = localClock(now, this.timezone);
    if (clock.time < settings.time || settings.lastRun === clock.date) return null;
    const result = await this.run("scheduler", now);
    this.database.setPaymentOptionLastRun(clock.date);
    return result;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => {
      console.error(`Payment option scheduler failed: ${String(error.message).slice(0, 300)}`);
    }), 30_000);
    this.timer.unref?.();
    this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { DUE_STATES, PaymentOptionReconciler, RUN_LIMIT, overlaps };
