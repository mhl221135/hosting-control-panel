const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { AuthStore, apiAuthorized } = require("./lib/auth");
const { BillingBackups } = require("./lib/backups");
const { exportCsv, importCsv } = require("./lib/csv");
const { BillingDatabase, SCHEMA_VERSION } = require("./lib/database");
const { EntitlementRefreshClient } = require("./lib/entitlement-refresh");
const { PaymentManager, addMonths } = require("./lib/payments");
const { PaymentOptionReconciler } = require("./lib/payment-reconciler");
const { PublicReference } = require("./lib/public-reference");
const { NotificationClient, ReminderManager } = require("./lib/reminders");
const { WooCommerceClient, WooCommerceSettings } = require("./lib/woocommerce-settings");
const { domain, integer, isoDate, normalizeService } = require("./lib/validation");
const {
  buildEntitlementPayload,
  decryptPrivateKey,
  encryptPrivateKey,
  generateSigningKey,
  loadEncryptionKey,
  signPayload,
  verifySignature,
} = require("./lib/enrollment-signing");

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "/app/data");
const BACKUPS_ROOT = path.resolve(process.env.BACKUPS_ROOT || "/srv/backups");
const PUBLIC_ROOT = path.join(__dirname, "public");
const MAX_BODY = 6 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_ROOT, { recursive: true });

const database = new BillingDatabase(DATA_DIR);
const backups = new BillingBackups(database, BACKUPS_ROOT, process.env.BILLING_BACKUP_RETENTION || 14);
const auth = new AuthStore(DATA_DIR);
const wooSettings = new WooCommerceSettings(DATA_DIR);
const wooClient = new WooCommerceClient(wooSettings);
const payments = new PaymentManager(database, wooSettings, wooClient);
const paymentOptions = new PaymentOptionReconciler(database, payments);
const publicReference = new PublicReference(DATA_DIR);
const reminderManager = new ReminderManager(database, new NotificationClient());
const entitlementRefresh = new EntitlementRefreshClient();
const publicRequests = new Map();
const installationRequests = new Map();
const SIGNING_ENCRYPTION_KEY = loadEncryptionKey(process.env.BILLING_SETTINGS_KEY || "");

function headers(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra,
  };
}

function json(res, status, body, extra = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, headers({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    ...extra,
  }));
  res.end(payload);
}

function html(res, status, body) {
  const payload = Buffer.from(body);
  res.writeHead(status, headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": payload.length,
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  }));
  res.end(payload);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

function publicRateLimit(req) {
  const key = String(req.socket.remoteAddress || "unknown");
  const now = Date.now();
  const current = publicRequests.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    publicRequests.set(key, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > 300) {
    throw Object.assign(new Error("Too many requests"), { statusCode: 429 });
  }
  if (publicRequests.size > 1000) {
    for (const [address, value] of publicRequests) {
      if (now - value.startedAt >= 60_000) publicRequests.delete(address);
    }
  }
}

// Rate-limit remote installation requests: per-installation and per-IP, suitable
// for periodic plugin polling. Authentication errors also consume quota.
function remoteRateLimit(req, installationId = "") {
  const ip = String(req.socket.remoteAddress || "unknown");
  const now = Date.now();
  const keys = [];
  if (installationId) keys.push(`install:${installationId}`);
  keys.push(`ip:${ip}`);
  for (const key of keys) {
    const current = installationRequests.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      installationRequests.set(key, { startedAt: now, count: 1 });
      continue;
    }
    current.count += 1;
    if (current.count > 60) {
      throw Object.assign(new Error("Too many requests"), { statusCode: 429 });
    }
  }
  if (installationRequests.size > 2000) {
    for (const [k, v] of installationRequests) {
      if (now - v.startedAt >= 60_000) installationRequests.delete(k);
    }
  }
}

function renewalPage(service, reference) {
  const available = database.publicPayments(service.service_id);
  const support = wooSettings.public();
  const paymentMarkup = available.length ? available.map((payment) => {
    const lines = [];
    if (payment.hosting_months) {
      lines.push(`Hosting: ${payment.hosting_months} months, through ${escapeHtml(payment.resulting_hosting_paid_through)}`);
    }
    if (payment.domain_months) {
      lines.push(`Domain: ${payment.domain_months} months, through ${escapeHtml(payment.resulting_domain_paid_through)}`);
    }
    return `<article class="renewal-option">
      <div class="renewal-option-copy"><span class="renewal-label">${escapeHtml(payment.selection)} renewal</span>
      <strong>${escapeHtml(payment.hosting_months || payment.domain_months)} month${Number(payment.hosting_months || payment.domain_months) === 1 ? "" : "s"} of service</strong>
      <small>${lines.join("<br>")}</small></div>
      <div class="renewal-price"><strong><span>${escapeHtml((payment.amount_minor / 100).toFixed(2))}</span> ${escapeHtml(payment.currency)}</strong>
      <a class="button primary" href="/renew/${escapeHtml(reference)}/checkout/${escapeHtml(payment.payment_id)}">Pay securely</a></div>
    </article>`;
  }).join("") : `<p class="renewal-empty">No payment option is currently available.${
    support.supportUrl
      ? ` <a class="button secondary" href="${escapeHtml(support.supportUrl)}" target="_blank" rel="noopener nofollow">${escapeHtml(support.supportLabel)}</a>`
      : " Contact the website administrator."
  }</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Renew ${escapeHtml(service.primary_domain)}</title><link rel="stylesheet" href="/styles.css?v=7"></head>
<body class="renewal-page"><main class="renewal-shell"><header class="renewal-header"><span class="brand-mark">HP</span>
<div><p class="eyebrow">Hosting renewal</p><h1>${escapeHtml(service.primary_domain)}</h1><p class="renewal-intro">Restore uninterrupted website service by completing a renewal below.</p></div></header>
<section class="renewal-status"><div><span>Website status</span>
<strong class="state state-${escapeHtml(service.hosting_state)}">${escapeHtml(service.hosting_state)}</strong>
<small>Hosting paid through ${escapeHtml(service.hosting_paid_through || "not set")}</small></div></section>
<section class="renewal-options"><div class="renewal-section-heading"><p class="eyebrow">Choose a plan</p><h2>Available renewal options</h2></div>${paymentMarkup}</section>
<footer class="renewal-footnote"><span aria-hidden="true">SSL</span><p><strong>Secure checkout</strong><br>Payment is completed through our configured WooCommerce store.</p></footer>
</main></body></html>`;
}

function renewalUnavailable() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Renewal unavailable</title><link rel="stylesheet" href="/styles.css?v=7"></head>
<body class="renewal-page"><main class="renewal-shell"><header class="renewal-header"><span class="brand-mark">HP</span>
<div><p class="eyebrow">Website renewal</p><h1>Renewal unavailable</h1></div></header>
<p class="renewal-empty">This renewal link is invalid or no longer available. Contact the website administrator.</p>
</main></body></html>`;
}

function readBody(req, maximum = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let body = "";
    let exceeded = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (exceeded) return;
      body += chunk;
      if (Buffer.byteLength(body) > maximum) {
        exceeded = true;
        reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
      }
    });
    req.on("end", () => { if (!exceeded) resolve(body); });
    req.on("error", reject);
  });
}

async function readJson(req, maximum = MAX_BODY) {
  try {
    return JSON.parse((await readBody(req, maximum)) || "{}");
  } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error("Request body must be valid JSON"), { statusCode: 400 });
  }
}

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function validateRequestStructure(value, depth = 0, state = { nodes: 0 }) {
  state.nodes += 1;
  if (depth > 8 || state.nodes > 256) {
    throw Object.assign(new Error("Request structure is too complex"), { statusCode: 400 });
  }
  if (typeof value === "string" && /[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new Error("Request contains invalid characters"), { statusCode: 400 });
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > 100) throw Object.assign(new Error("Request array is too large"), { statusCode: 400 });
    for (const item of value) validateRequestStructure(item, depth + 1, state);
    return;
  }
  for (const key of Object.keys(value)) {
    if (POLLUTION_KEYS.has(key)) {
      throw Object.assign(new Error("Unsupported request structure"), { statusCode: 400 });
    }
    if (/[^\x20-\x7e]/.test(key)) {
      throw Object.assign(new Error("Request contains invalid field names"), { statusCode: 400 });
    }
    validateRequestStructure(value[key], depth + 1, state);
  }
}

async function readGuardedJson(req, allowed, stringKeys = [], maximum = 4096) {
  const body = await readJson(req, maximum);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("Request body must be a JSON object"), { statusCode: 400 });
  }
  validateRequestStructure(body);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw Object.assign(new Error("Request contains an unsupported field"), { statusCode: 400 });
  }
  for (const key of stringKeys) {
    if (Object.prototype.hasOwnProperty.call(body, key)
      && /[\u0000-\u001f\u007f]/.test(String(body[key]))) {
      throw Object.assign(new Error(`Invalid characters in ${key}`), { statusCode: 400 });
    }
  }
  return body;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(value || ""));
}

function enrollmentCodeShape(value) {
  return /^[A-Za-z0-9_-]{32}$/.test(String(value || ""));
}

function installationCredentialShape(value) {
  return /^[A-Za-z0-9_-]{43}$/.test(String(value || ""));
}

function serviceIdShape(value) {
  return /^[a-z0-9][a-z0-9_-]{5,79}$/.test(String(value || ""));
}

function requireStringField(body, key) {
  if (typeof body[key] !== "string") {
    throw Object.assign(new Error(`${key} must be a string`), { statusCode: 400 });
  }
  return body[key];
}

function sessionRequired(req) {
  const session = auth.session(req);
  if (!session) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  if (!["GET", "HEAD"].includes(req.method) && req.headers["x-csrf-token"] !== session.csrf) {
    throw Object.assign(new Error("Invalid CSRF token"), { statusCode: 403 });
  }
  return session;
}

function publicFile(target) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(target, "http://billing.local").pathname);
  } catch {
    return null;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_ROOT, relative);
  return resolved === PUBLIC_ROOT || resolved.startsWith(`${PUBLIC_ROOT}${path.sep}`) ? resolved : null;
}

function serveStatic(req, res) {
  const file = publicFile(req.url);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const extension = path.extname(file);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  }[extension] || "application/octet-stream";
  const content = fs.readFileSync(file);
  res.writeHead(200, headers({
    "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600",
    "Content-Type": contentType,
    "Content-Length": content.length,
  }));
  res.end(content);
  return true;
}

function entitlementPayload() {
  const publicBillingUrl = wooSettings.public().publicBillingUrl;
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    services: database.services().map((service) => ({
      serviceId: service.service_id,
      primaryDomain: service.primary_domain,
      aliases: service.aliases,
      state: service.hosting_state,
      paidThrough: service.hosting_paid_through,
      graceDays: service.grace_days,
      enforcementMode: service.enforcement_mode,
      renewalUrl: publicBillingUrl
        ? `${publicBillingUrl}/renew/${publicReference.forService(service.service_id)}`
        : "",
    })),
  };
  const canonical = JSON.stringify(payload);
  return {
    ...payload,
    signature: crypto.createHmac("sha256", process.env.BILLING_API_TOKEN).update(canonical).digest("base64url"),
  };
}

async function api(req, res) {
  const url = new URL(req.url, "http://billing.local");
  if (req.method === "GET" && url.pathname === "/health") {
    const healthy = !backups.active && database.healthy();
    json(res, healthy ? 200 : 503, {
      ok: healthy,
      service: "hosting-billing",
      schemaVersion: SCHEMA_VERSION,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/internal/v1/entitlements") {
    if (backups.active) {
      json(res, 503, { ok: false, message: "Billing maintenance is in progress" });
      return true;
    }
    if (!apiAuthorized(req)) {
      json(res, 401, { ok: false, message: "API authentication required" });
      return true;
    }
    json(res, 200, entitlementPayload());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/internal/v1/services") {
    if (backups.active) {
      json(res, 503, { ok: false, message: "Billing maintenance is in progress" });
      return true;
    }
    if (!apiAuthorized(req)) {
      json(res, 401, { ok: false, message: "API authentication required" });
      return true;
    }
    const idempotencyKey = String(req.headers["idempotency-key"] || "");
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
      throw Object.assign(new Error("A valid idempotency key is required"), { statusCode: 400 });
    }
    const body = await readJson(req);
    const primaryDomain = domain(body.primary_domain);
    const freeMonths = integer(body.free_months, 0, 60, 6);
    const grantFreePeriod = body.grant_free_period === true;
    const trialAnchor = body.trial_anchor ? isoDate(body.trial_anchor) : "";
    const service = normalizeService({
      primary_domain: primaryDomain,
      aliases: body.aliases,
      customer_name: body.customer_name,
      contact_email: body.contact_email,
      contact_phone: body.contact_phone,
      location: "local",
      provider: "hosting-control-panel",
      hosting_paid_through: grantFreePeriod ? addMonths(trialAnchor, freeMonths) : "",
      domain_paid_through: body.domain_paid_through,
      renewal_months: body.renewal_months,
      domain_renewal_months: body.domain_renewal_months,
      hosting_price_minor: body.hosting_price_minor,
      domain_price_minor: body.domain_price_minor,
      currency: body.currency,
      grace_days: body.grace_days,
      enforcement_mode: "none",
      timezone: body.timezone || "Europe/Kyiv",
      notes: body.notes,
      source_ref: `provision:${primaryDomain}`,
    });
    const existing = database.serviceByDomain(service.primary_domain);
    if (existing) {
      database.auditEntry("hosting-ui", "inventory.provision_replay", existing.service_id, {
        idempotencyKey,
        primaryDomain: existing.primary_domain,
      });
      json(res, 200, {
        ok: true,
        created: false,
        service: { serviceId: existing.service_id, primaryDomain: existing.primary_domain },
      });
      return true;
    }
    const created = database.createService(service, "hosting-ui");
    database.auditEntry("hosting-ui", "inventory.provision_register", created.service_id, {
      idempotencyKey,
      primaryDomain: created.primary_domain,
      grantFreePeriod,
      freeMonths,
    });
    json(res, 201, {
      ok: true,
      created: true,
      service: { serviceId: created.service_id, primaryDomain: created.primary_domain },
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(req);
    const session = auth.login(req, body.email, body.password);
    json(res, 200, { authenticated: true, email: session.email, csrf: session.csrf }, {
      "Set-Cookie": auth.cookie(req, session.id),
    });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    const session = auth.session(req);
    json(res, 200, session
      ? { authenticated: true, email: session.email, csrf: session.csrf }
      : { authenticated: false });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    sessionRequired(req);
    auth.logout(req);
    json(res, 200, { ok: true }, { "Set-Cookie": auth.cookie(req, "", true) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/enrollment/exchange") {
    publicRateLimit(req);
    const body = await readGuardedJson(req, new Set(["code", "domain"]), ["code", "domain"]);
    const code = requireStringField(body, "code");
    const claimedDomain = requireStringField(body, "domain");
    if (!enrollmentCodeShape(code)) {
      throw Object.assign(new Error("Enrollment code shape is invalid"), { statusCode: 400 });
    }
    const result = database.exchangeEnrollmentCode({ code, domain: claimedDomain });
    json(res, 200, { ok: true, installation_id: result.installationId, credential: result.credential });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/remote/v1/keys") {
    publicRateLimit(req);
    const keys = database.eligiblePublicKeys().map((k) => ({
      key_id: k.key_id,
      public_key: k.public_key,
      active: k.active,
      overlap_ends_at: k.overlap_ends_at,
    }));
    json(res, 200, { ok: true, keys });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/remote/v1/entitlement") {
    const authorization = String(req.headers.authorization || "");
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match) {
      remoteRateLimit(req);
      json(res, 401, { ok: false, message: "Installation authentication required" });
      return true;
    }
    const credential = match[1];
    const installationId = String(req.headers["x-installation-id"] || "");
    if (!isUuid(installationId) || !installationCredentialShape(credential)) {
      remoteRateLimit(req);
      json(res, 401, { ok: false, message: "Installation authentication required" });
      return true;
    }
    const installation = database.authenticateInstallation(installationId, credential);
    if (!installation) {
      remoteRateLimit(req);
      json(res, 401, { ok: false, message: "Installation authentication required" });
      return true;
    }
    remoteRateLimit(req, installation.installation_id);
    if (!SIGNING_ENCRYPTION_KEY) {
      json(res, 503, { ok: false, message: "Entitlement signing is not configured" });
      return true;
    }
    const activeKey = database.activeSigningKeyRaw();
    if (!activeKey) {
      json(res, 503, { ok: false, message: "No active signing key is available" });
      return true;
    }
    const service = database.service(installation.service_id);
    let privateKey;
    try {
      privateKey = decryptPrivateKey(activeKey.private_key_encrypted, SIGNING_ENCRYPTION_KEY);
    } catch {
      json(res, 503, { ok: false, message: "Entitlement signing key is unavailable" });
      return true;
    }
    if (!privateKey) {
      json(res, 503, { ok: false, message: "Entitlement signing is not configured" });
      return true;
    }
    const payload = buildEntitlementPayload({
      installation,
      service,
      keyId: activeKey.key_id,
      renewalUrl: wooSettings.public().publicBillingUrl && service
        ? `${wooSettings.public().publicBillingUrl}/renew/${publicReference.forService(service.service_id)}`
        : "",
    });
    const { canonical, signature } = signPayload(privateKey, payload);
    if (!verifySignature(activeKey.public_key, canonical, signature)) {
      json(res, 503, { ok: false, message: "Entitlement signing key is unavailable" });
      return true;
    }
    database.heartbeatInstallation(installation.installation_id, {
      contractVersion: payload.contract_version,
      safeStatus: payload.entitlement_state,
    });
    json(res, 200, {
      ok: true,
      payload,
      signature,
    });
    return true;
  }

  const session = sessionRequired(req);
  if (backups.active) throw Object.assign(new Error("Billing maintenance is in progress"), { statusCode: 503 });

  if (req.method === "PUT" && url.pathname === "/api/auth/account") {
    const body = await readJson(req);
    const updated = auth.update(session, body.current_password, body.email, body.new_password);
    database.auditEntry(updated.email, "account.update", updated.email, {});
    json(res, 200, { ok: true, email: updated.email, csrf: updated.csrf });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    json(res, 200, { ok: true, summary: database.summary(), reminderDays: database.reminderDays() });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/services") {
    json(res, 200, {
      ok: true,
      services: database.services({
        search: url.searchParams.get("search"),
        state: url.searchParams.get("state"),
        archived: url.searchParams.get("archived"),
      }),
    });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/services") {
    const service = normalizeService(await readJson(req));
    json(res, 201, { ok: true, service: database.createService(service, session.email) });
    return true;
  }
  const serviceMatch = /^\/api\/services\/([^/]+)$/.exec(url.pathname);
  if (req.method === "PUT" && serviceMatch) {
    const serviceId = decodeURIComponent(serviceMatch[1]);
    const body = await readJson(req);
    const service = normalizeService({ ...body, service_id: serviceId });
    json(res, 200, {
      ok: true,
      service: database.updateService(serviceId, service, body.updated_at, session.email),
    });
    return true;
  }
  const archiveMatch = /^\/api\/services\/([^/]+)\/archive$/.exec(url.pathname);
  if (req.method === "POST" && archiveMatch) {
    const body = await readJson(req);
    if (typeof body.archived !== "boolean") {
      throw Object.assign(new Error("archived must be a boolean"), { statusCode: 400 });
    }
    const service = database.archiveService(
      decodeURIComponent(archiveMatch[1]),
      body.archived,
      body.updated_at,
      session.email,
    );
    json(res, 200, { ok: true, service });
    return true;
  }
  const manualActionMatch = /^\/api\/services\/([^/]+)\/actions\/(exempt|resume|suspend)$/.exec(url.pathname);
  if (req.method === "POST" && manualActionMatch) {
    const body = await readJson(req);
    const service = database.applyManualAction(
      decodeURIComponent(manualActionMatch[1]),
      manualActionMatch[2],
      body.reason,
      body.updated_at,
      session.email,
    );
    json(res, 200, { ok: true, service });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/audit") {
    json(res, 200, { ok: true, audit: database.audit(Number(url.searchParams.get("limit") || 100)) });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/payments") {
    json(res, 200, { ok: true, payments: database.payments(Number(url.searchParams.get("limit") || 100)) });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/reminders") {
    json(res, 200, {
      ok: true,
      settings: database.reminderSettings(),
      preview: reminderManager.preview(),
      history: database.reminderHistory(Number(url.searchParams.get("limit") || 100)),
      running: reminderManager.running,
    });
    return true;
  }
  if (req.method === "PUT" && url.pathname === "/api/reminders/settings") {
    const body = await readJson(req);
    json(res, 200, { ok: true, settings: database.updateReminderSettings(body, session.email) });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/reminders/run") {
    json(res, 200, { ok: true, result: await reminderManager.run(session.email) });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/payment-options") {
    json(res, 200, {
      ok: true,
      settings: database.paymentOptionSettings(),
      preview: paymentOptions.preview(),
      running: paymentOptions.running,
    });
    return true;
  }
  if (req.method === "PUT" && url.pathname === "/api/payment-options/settings") {
    const body = await readJson(req);
    json(res, 200, { ok: true, settings: database.updatePaymentOptionSettings(body, session.email) });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/payment-options/run") {
    const body = await readJson(req);
    if (body.confirm !== "CREATE") {
      throw Object.assign(new Error("Type CREATE to confirm WooCommerce order creation"), { statusCode: 400 });
    }
    json(res, 200, { ok: true, result: await paymentOptions.run(session.email) });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/woocommerce/settings") {
    json(res, 200, { ok: true, settings: wooSettings.public() });
    return true;
  }
  if (req.method === "PUT" && url.pathname === "/api/woocommerce/settings") {
    const body = await readJson(req);
    const settings = wooSettings.update(body);
    database.auditEntry(session.email, "woocommerce.settings_update", settings.siteUrl, {
      siteUrl: settings.siteUrl,
      publicBillingUrl: settings.publicBillingUrl,
      productId: settings.productId,
      linkHours: settings.linkHours,
      supportUrl: settings.supportUrl,
      supportLabel: settings.supportLabel,
    });
    json(res, 200, { ok: true, settings });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/woocommerce/test") {
    const result = await wooClient.test();
    database.auditEntry(session.email, "woocommerce.test", String(result.productId), result);
    json(res, 200, { ok: true, result });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/public-reference/status") {
    json(res, 200, { ok: true, status: publicReference.status() });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/public-reference/rotate") {
    const body = await readJson(req);
    if (body.confirm !== "ROTATE") {
      throw Object.assign(new Error("Type ROTATE to confirm public renewal URL key rotation"), { statusCode: 400 });
    }
    const reason = String(body.reason || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
    if (reason.length < 3) {
      throw Object.assign(new Error("A rotation reason of at least 3 characters is required"), { statusCode: 400 });
    }
    const overlapHours = integer(body.overlap_hours, 24, 2160, 720);
    const before = publicReference.status();
    const status = publicReference.rotate(overlapHours);
    database.auditEntry(session.email, "public_reference.rotate", status.activeFingerprint, {
      reason,
      overlapHours,
      previousFingerprint: before.activeFingerprint,
      previousExpiresAt: status.previous.expiresAt,
    });
    json(res, 200, { ok: true, status });
    return true;
  }
  const paymentLinkMatch = /^\/api\/services\/([^/]+)\/payment-link$/.exec(url.pathname);
  if (req.method === "POST" && paymentLinkMatch) {
    const result = await payments.create(decodeURIComponent(paymentLinkMatch[1]), await readJson(req), session.email);
    const reference = publicReference.forService(result.serviceId);
    json(res, 201, {
      ok: true,
      payment: {
        ...result,
        renewalUrl: `${wooSettings.public().publicBillingUrl}/renew/${reference}`,
      },
    });
    return true;
  }
  const paymentCancelMatch = /^\/api\/payments\/([^/]+)\/cancel$/.exec(url.pathname);
  if (req.method === "POST" && paymentCancelMatch) {
    const body = await readJson(req);
    const payment = await payments.cancel(
      decodeURIComponent(paymentCancelMatch[1]),
      body.reason,
      session.email,
    );
    json(res, 200, { ok: true, payment });
    return true;
  }
  const paymentReviewMatch = /^\/api\/payments\/([^/]+)\/review\/resolve$/.exec(url.pathname);
  if (req.method === "POST" && paymentReviewMatch) {
    const body = await readJson(req);
    const payment = database.resolvePaymentReview(
      decodeURIComponent(paymentReviewMatch[1]),
      body.reason,
      session.email,
    );
    json(res, 200, { ok: true, payment });
    return true;
  }
  if (req.method === "PUT" && url.pathname === "/api/settings") {
    const body = await readJson(req);
    json(res, 200, {
      ok: true,
      reminderDays: database.updateReminderDays(body.reminder_days, session.email),
    });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/import/preview") {
    const body = await readJson(req);
    const preview = importCsv(body.csv);
    json(res, 200, {
      ok: true,
      fingerprint: preview.fingerprint,
      count: preview.services.length,
      sample: preview.services.slice(0, 10).map((service) => ({
        service_id: service.service_id,
        primary_domain: service.primary_domain,
        customer_name: service.customer_name,
        hosting_paid_through: service.hosting_paid_through,
      })),
    });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/import/apply") {
    const body = await readJson(req);
    if (body.confirm !== "IMPORT") throw Object.assign(new Error("Type IMPORT to confirm the reviewed inventory"), { statusCode: 400 });
    const parsed = importCsv(body.csv);
    if (parsed.fingerprint !== body.fingerprint) {
      throw Object.assign(new Error("CSV changed after preview; create a new preview"), { statusCode: 409 });
    }
    json(res, 200, { ok: true, result: database.importServices(parsed.services, parsed.fingerprint, session.email) });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/export.csv") {
    const content = Buffer.from(exportCsv(database.services()));
    database.auditEntry(session.email, "inventory.export", "all", { rows: database.summary().total });
    res.writeHead(200, headers({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="hosting-services-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Content-Length": content.length,
    }));
    res.end(content);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/backups") {
    json(res, 200, { ok: true, backups: backups.list() });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/backups") {
    const manifest = await backups.create("manual", session.email);
    database.auditEntry(session.email, "backup.create", manifest.id, { services: manifest.services, size: manifest.size });
    json(res, 201, { ok: true, backup: manifest });
    return true;
  }
  const backupMatch = /^\/api\/backups\/([^/]+)\/(test|restore)$/.exec(url.pathname);
  if (req.method === "POST" && backupMatch) {
    const id = decodeURIComponent(backupMatch[1]);
    if (backupMatch[2] === "test") {
      const result = backups.test(id);
      database.auditEntry(session.email, "backup.test", id, result);
      json(res, 200, { ok: true, result });
    } else {
      const body = await readJson(req);
      if (body.confirm !== id) throw Object.assign(new Error(`Type ${id} to confirm restore`), { statusCode: 400 });
      json(res, 200, { ok: true, result: await backups.restore(id, session.email) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/enrollment/codes") {
    const body = await readGuardedJson(req, new Set(["service_id", "canonical_domain", "expires_in_hours"]));
    const serviceId = requireStringField(body, "service_id");
    const canonicalDomain = requireStringField(body, "canonical_domain");
    if (!serviceIdShape(serviceId)) {
      throw Object.assign(new Error("service_id is invalid"), { statusCode: 400 });
    }
    if (body.expires_in_hours !== undefined
      && (typeof body.expires_in_hours !== "number" || !Number.isInteger(body.expires_in_hours))) {
      throw Object.assign(new Error("expires_in_hours must be an integer number"), { statusCode: 400 });
    }
    const result = database.createEnrollmentCode({
      serviceId,
      canonicalDomain,
      expiresInHours: body.expires_in_hours,
      actor: session.email,
    });
    json(res, 201, { ok: true, codeId: result.codeId, code: result.code, expiresAt: result.expiresAt });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/enrollment/codes/revoke") {
    const body = await readGuardedJson(req, new Set(["code_id"]));
    if (!isUuid(body.code_id)) {
      throw Object.assign(new Error("code_id must be a UUID"), { statusCode: 400 });
    }
    json(res, 200, { ok: true, ...database.revokeEnrollmentCode(body.code_id, session.email) });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/enrollment/codes") {
    const serviceId = String(url.searchParams.get("service_id") || "");
    if (!serviceIdShape(serviceId)) {
      throw Object.assign(new Error("service_id is required and must be valid"), { statusCode: 400 });
    }
    if (!database.service(serviceId)) {
      throw Object.assign(new Error("Billing service was not found"), { statusCode: 404 });
    }
    json(res, 200, { ok: true, serviceId, codes: database.listEnrollmentCodesForService(serviceId) });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/enrollment/installations/revoke") {
    const body = await readGuardedJson(req, new Set(["installation_id"]));
    if (!isUuid(body.installation_id)) {
      throw Object.assign(new Error("installation_id must be a UUID"), { statusCode: 400 });
    }
    json(res, 200, { ok: true, ...database.revokeInstallationCredential(body.installation_id, session.email) });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/enrollment/installations") {
    const serviceId = String(url.searchParams.get("service_id") || "");
    if (!serviceIdShape(serviceId)) {
      throw Object.assign(new Error("service_id is required and must be valid"), { statusCode: 400 });
    }
    if (!database.service(serviceId)) {
      throw Object.assign(new Error("Billing service was not found"), { statusCode: 404 });
    }
    const installations = database.listInstallationsForService(serviceId);
    json(res, 200, { ok: true, serviceId, installations });
    return true;
  }

  const installPreviewMatch = /^\/api\/enrollment\/installations\/([0-9a-f-]{36})\/entitlement-preview$/.exec(url.pathname);
  if (req.method === "GET" && installPreviewMatch) {
    const installation = database.getInstallationHealth(installPreviewMatch[1]);
    if (!installation) throw Object.assign(new Error("Installation was not found"), { statusCode: 404 });
    const service = database.service(installation.service_id);
    const key = database.activePublicKey();
    const payload = buildEntitlementPayload({
      installation,
      service: service ? service : null,
      keyId: key ? key.keyId : "no-active-key",
      renewalUrl: wooSettings.public().publicBillingUrl && service
        ? `${wooSettings.public().publicBillingUrl}/renew/${publicReference.forService(service.service_id)}`
        : "",
    });
    json(res, 200, { ok: true, preview: payload, signed: false });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/enrollment/signing/status") {
    json(res, 200, { ok: true, status: database.signingKeyStatus(), configured: Boolean(SIGNING_ENCRYPTION_KEY) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/enrollment/signing/initialize") {
    const body = await readGuardedJson(req, new Set(["confirm"]));
    requireStringField(body, "confirm");
    if (body.confirm !== "INITIALIZE") {
      throw Object.assign(new Error("Type INITIALIZE to create the first signing key"), { statusCode: 400 });
    }
    if (!SIGNING_ENCRYPTION_KEY) {
      throw Object.assign(new Error("Set BILLING_SETTINGS_KEY before enabling signing"), { statusCode: 503 });
    }
    const key = generateSigningKey();
    const privateKeyEncrypted = encryptPrivateKey(key.privateKey, SIGNING_ENCRYPTION_KEY);
    const keyId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 90 * 24 * 3600_000).toISOString();
    const result = database.initSigningKey(keyId, key.publicKey, privateKeyEncrypted, expiresAt, 720, session.email);
    json(res, 201, { ok: true, keyId: result, publicKey: key.publicKey });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/enrollment/signing/rotate") {
    const body = await readGuardedJson(req, new Set(["confirm", "expected_key_id"]));
    requireStringField(body, "confirm");
    requireStringField(body, "expected_key_id");
    if (body.confirm !== "ROTATE") {
      throw Object.assign(new Error("Type ROTATE to replace the active signing key"), { statusCode: 400 });
    }
    if (!SIGNING_ENCRYPTION_KEY) throw Object.assign(new Error("Set BILLING_SETTINGS_KEY before enabling signing"), { statusCode: 503 });
    if (!isUuid(body.expected_key_id)) {
      throw Object.assign(new Error("expected_key_id must be a UUID"), { statusCode: 400 });
    }
    const key = generateSigningKey();
    const privateKeyEncrypted = encryptPrivateKey(key.privateKey, SIGNING_ENCRYPTION_KEY);
    const keyId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 90 * 24 * 3600_000).toISOString();
    const overlapHours = 720;
    const result = database.rotateSigningKey(
      keyId,
      key.publicKey,
      privateKeyEncrypted,
      expiresAt,
      overlapHours,
      session.email,
      body.expected_key_id,
    );
    json(res, 201, { ok: true, keyId: result, publicKey: key.publicKey, previousKeyRotated: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/enrollment/signing/retire") {
    const body = await readGuardedJson(req, new Set(["key_id", "confirm"]));
    requireStringField(body, "key_id");
    requireStringField(body, "confirm");
    if (!isUuid(body.key_id)) throw Object.assign(new Error("key_id must be a UUID"), { statusCode: 400 });
    const emergency = body.confirm === "EMERGENCY";
    const allowed = emergency || body.confirm === "RETIRE";
    if (!allowed) {
      throw Object.assign(new Error("Type RETIRE (or EMERGENCY to skip the overlap window)"), { statusCode: 400 });
    }
    const result = database.retireSigningKey(body.key_id, emergency, session.email);
    json(res, 200, { ok: true, ...result });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://billing.local");
    const renewalCheckout = /^\/renew\/(r1_[A-Za-z0-9_-]{43})\/checkout\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === "GET" && renewalCheckout) {
      publicRateLimit(req);
      const service = publicReference.resolve(renewalCheckout[1], database.services());
      if (!service) {
        html(res, 404, renewalUnavailable());
        return;
      }
      let checkoutUrl;
      try {
        checkoutUrl = database.resolvePublicPayment(service.service_id, renewalCheckout[2]);
      } catch (error) {
        if ([404, 410].includes(error.statusCode)) {
          html(res, error.statusCode, renewalUnavailable());
          return;
        }
        throw error;
      }
      res.writeHead(302, headers({
        Location: checkoutUrl,
        "Content-Length": 0,
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      }));
      res.end();
      return;
    }
    const renewalMatch = /^\/renew\/(r1_[A-Za-z0-9_-]{43})$/.exec(url.pathname);
    if (req.method === "GET" && renewalMatch) {
      publicRateLimit(req);
      const service = publicReference.resolve(renewalMatch[1], database.services());
      html(res, service ? 200 : 404, service ? renewalPage(service, renewalMatch[1]) : renewalUnavailable());
      return;
    }
    const payMatch = /^\/pay\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
    if (req.method === "GET" && payMatch) {
      const checkoutUrl = payments.resolve(payMatch[1]);
      res.writeHead(302, headers({ Location: checkoutUrl, "Content-Length": 0 }));
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/webhooks/woocommerce") {
      const rawBody = await readBody(req);
      const result = payments.webhook(rawBody, {
        signature: req.headers["x-wc-webhook-signature"],
        deliveryId: req.headers["x-wc-webhook-delivery-id"],
        topic: req.headers["x-wc-webhook-topic"],
      });
      json(res, 200, { ok: true, duplicate: result.duplicate, result: result.result });
      if (!result.duplicate && result.result === "paid") {
        entitlementRefresh.trigger(String(req.headers["x-wc-webhook-delivery-id"] || "")).catch((error) => {
          console.error(`Post-payment entitlement refresh failed: ${String(error.message).slice(0, 300)}`);
        });
      }
      return;
    }
    if (req.url.startsWith("/api/") || req.url.startsWith("/internal/") || req.url.startsWith("/remote/v1/") || req.url === "/health") {
      if (!await api(req, res)) json(res, 404, { ok: false, message: "Not found" });
      return;
    }
    if (!["GET", "HEAD"].includes(req.method) || !serveStatic(req, res)) {
      json(res, 404, { ok: false, message: "Not found" });
    }
  } catch (error) {
    console.error(`${req.method} ${req.url}: ${error.message}`);
    json(res, error.statusCode || 500, {
      ok: false,
      message: error.statusCode ? error.message : "Internal server error",
      ...(error.details ? { details: error.details } : {}),
    });
  }
});

server.headersTimeout = 15_000;
server.requestTimeout = 60_000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Hosting billing listening on ${PORT}`);
  reminderManager.start();
  paymentOptions.start();
});

function shutdown() {
  reminderManager.stop();
  paymentOptions.stop();
  server.close(() => {
    database.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
