const crypto = require("crypto");
const { validateDomain } = require("./provisioner");

const STATES = new Set(["reminder", "grace", "suspended"]);

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length >= 32 && crypto.timingSafeEqual(a, b);
}

function authorized(req, token = process.env.BILLING_API_TOKEN) {
  const match = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
  return Boolean(match && safeEqual(match[1], token));
}

function validatedReminder(input) {
  const serviceId = String(input.service_id || "");
  if (!/^[a-z0-9][a-z0-9_-]{5,79}$/.test(serviceId)) throw Object.assign(new Error("Invalid billing service ID"), { statusCode: 400 });
  const domain = validateDomain(input.domain);
  const state = String(input.state || "").toLowerCase();
  if (!STATES.has(state)) throw Object.assign(new Error("Invalid billing reminder state"), { statusCode: 400 });
  const paidThrough = String(input.paid_through || "");
  const paidDate = new Date(`${paidThrough}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidThrough)
    || Number.isNaN(paidDate.valueOf()) || paidDate.toISOString().slice(0, 10) !== paidThrough) {
    throw Object.assign(new Error("Invalid paid-through date"), { statusCode: 400 });
  }
  const days = Number(input.days_remaining);
  if (!Number.isInteger(days) || days < -3650 || days > 3650) {
    throw Object.assign(new Error("Invalid billing reminder day count"), { statusCode: 400 });
  }
  const reminderKey = String(input.reminder_key || "");
  if (!/^[a-f0-9]{64}$/.test(reminderKey)) throw Object.assign(new Error("Invalid billing reminder key"), { statusCode: 400 });
  const labels = {
    reminder: `Hosting renewal due: ${domain}`,
    grace: `Hosting renewal overdue: ${domain}`,
    suspended: `Hosting renewal requires attention: ${domain}`,
  };
  const timing = days >= 0 ? `${days} day${days === 1 ? "" : "s"} remaining` : `${Math.abs(days)} day${days === -1 ? "" : "s"} overdue`;
  return {
    eventType: "billing-reminder",
    eventId: reminderKey,
    dedupeKey: `billing-reminder:${reminderKey}`,
    severity: state === "suspended" ? "failure" : "warning",
    label: labels[state],
    status: state,
    targets: [domain],
    message: `Paid through ${paidThrough}; ${timing}. Service ${serviceId}.`,
    respectSeverityFilter: false,
  };
}

function validatedEntitlementRefresh(input) {
  const deliveryId = String(input.delivery_id || "");
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(deliveryId)) {
    throw Object.assign(new Error("Invalid WooCommerce delivery ID"), { statusCode: 400 });
  }
  return { deliveryId };
}

module.exports = { authorized, safeEqual, validatedEntitlementRefresh, validatedReminder };
