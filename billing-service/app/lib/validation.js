const crypto = require("crypto");

const LOCATIONS = new Set(["local", "shared", "notification"]);
const MANUAL_STATES = new Set(["", "active", "reminder", "grace", "suspended", "exempt"]);
const ENFORCEMENT_MODES = new Set(["none", "reminder", "manual", "payment_page"]);

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function bounded(value, maximum = 500) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum);
}

function domain(value, required = true) {
  let normalized = String(value || "").trim().toLowerCase();
  normalized = normalized.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!normalized && !required) return "";
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) {
    throw validationError(`Invalid website domain: ${bounded(value, 120)}`);
  }
  return normalized;
}

function email(value) {
  const normalized = bounded(value, 254).toLowerCase();
  if (normalized && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw validationError(`Invalid email address: ${normalized}`);
  }
  return normalized;
}

function integer(value, minimum, maximum, fallback = 0) {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw validationError(`Expected an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function moneyMinor(value) {
  if (value === "" || value === null || value === undefined) return 0;
  const normalized = String(value).replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000_000) {
    throw validationError(`Invalid monetary value: ${bounded(value, 80)}`);
  }
  return Math.round(parsed * 100);
}

function isoDate(value) {
  const input = bounded(value, 80);
  if (!input) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const date = new Date(`${input}T00:00:00Z`);
    if (!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === input) return input;
  }
  const numeric = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/.exec(input);
  if (numeric) {
    const year = numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const month = first > 12 ? second : first;
    const day = first > 12 ? first : second;
    const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return isoDate(candidate);
  }
  const parsed = new Date(input);
  if (!Number.isNaN(parsed.valueOf())) {
    return [
      parsed.getFullYear(),
      String(parsed.getMonth() + 1).padStart(2, "0"),
      String(parsed.getDate()).padStart(2, "0"),
    ].join("-");
  }
  throw validationError(`Invalid date: ${input}`);
}

function serviceId(value, sourceRef, primaryDomain) {
  const explicit = bounded(value, 80).toLowerCase();
  if (explicit) {
    if (!/^[a-z0-9][a-z0-9_-]{5,79}$/.test(explicit)) throw validationError(`Invalid service ID: ${explicit}`);
    return explicit;
  }
  const stable = sourceRef ? `source:${sourceRef}` : `domain:${primaryDomain}`;
  return `svc_${crypto.createHash("sha256").update(stable).digest("hex").slice(0, 24)}`;
}

function aliases(value, primaryDomain) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[;|\s]+/);
  return [...new Set(values.filter(Boolean).map((item) => domain(item)))]
    .filter((item) => item !== primaryDomain)
    .slice(0, 50);
}

function choice(value, allowed, fallback) {
  const normalized = bounded(value, 40).toLowerCase() || fallback;
  if (!allowed.has(normalized)) throw validationError(`Unsupported value: ${normalized}`);
  return normalized;
}

function boolean(value, fallback = false) {
  if (value === "" || value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = bounded(value, 10).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw validationError("Expected a boolean value");
}

function normalizeService(input) {
  const primaryDomain = domain(input.primary_domain || input.website);
  const sourceRef = bounded(input.source_ref || input.order_number, 120);
  const currency = bounded(input.currency || "USD", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw validationError(`Invalid currency: ${currency}`);
  const normalized = {
    service_id: serviceId(input.service_id, sourceRef, primaryDomain),
    primary_domain: primaryDomain,
    aliases: aliases(input.aliases, primaryDomain),
    customer_name: bounded(input.customer_name || input.client_name || input.client_type, 200),
    contact_email: email(input.contact_email || input.email),
    contact_phone: bounded(input.contact_phone || input.phone, 80),
    location: choice(input.location || input.hosting_location, LOCATIONS, "local"),
    provider: bounded(input.provider, 120),
    hosting_paid_through: isoDate(input.hosting_paid_through || input.hosting_next_payment),
    domain_paid_through: isoDate(input.domain_paid_through || input.domain_next_payment),
    renewal_months: integer(input.renewal_months || input.hosting_months, 1, 120, 12),
    domain_renewal_months: integer(
      input.domain_renewal_months || input.domain_months || input.renewal_months,
      1,
      120,
      12,
    ),
    hosting_price_minor: input.hosting_price_minor !== undefined
      ? integer(input.hosting_price_minor, 0, 10_000_000_000, 0)
      : moneyMinor(input.hosting_price || input.price_hosting),
    domain_price_minor: input.domain_price_minor !== undefined
      ? integer(input.domain_price_minor, 0, 10_000_000_000, 0)
      : moneyMinor(input.domain_price || input.price_domain),
    currency,
    grace_days: integer(input.grace_days, 0, 365, 7),
    enforcement_mode: choice(input.enforcement_mode, ENFORCEMENT_MODES, "none"),
    manual_state: choice(input.manual_state, MANUAL_STATES, ""),
    timezone: bounded(input.timezone || "UTC", 80),
    notes: bounded(input.notes, 2000),
    source_ref: sourceRef,
    archived: boolean(input.archived, false),
  };
  if (normalized.enforcement_mode === "payment_page" && normalized.location !== "local") {
    throw validationError("Payment page enforcement is available only for locally hosted services");
  }
  return normalized;
}

function stateForDate(paidThrough, settings, manualState = "", now = new Date()) {
  if (manualState) return manualState;
  if (!paidThrough) return "exempt";
  const paid = Date.parse(`${paidThrough}T23:59:59Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const reminder = paid - settings.reminderDays * 86_400_000;
  const grace = paid + settings.graceDays * 86_400_000;
  if (today <= reminder) return "active";
  if (today <= paid) return "reminder";
  if (today <= grace) return "grace";
  return "suspended";
}

module.exports = {
  bounded,
  domain,
  email,
  integer,
  isoDate,
  normalizeService,
  stateForDate,
  validationError,
};
