const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { AuthStore, apiAuthorized } = require("./lib/auth");
const { BillingBackups } = require("./lib/backups");
const { exportCsv, importCsv } = require("./lib/csv");
const { BillingDatabase, SCHEMA_VERSION } = require("./lib/database");
const { PaymentManager } = require("./lib/payments");
const { WooCommerceClient, WooCommerceSettings } = require("./lib/woocommerce-settings");

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY) {
        reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || "{}");
  } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error("Request body must be valid JSON"), { statusCode: 400 });
  }
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
      }),
    });
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
  const paymentLinkMatch = /^\/api\/services\/([^/]+)\/payment-link$/.exec(url.pathname);
  if (req.method === "POST" && paymentLinkMatch) {
    const result = await payments.create(decodeURIComponent(paymentLinkMatch[1]), await readJson(req), session.email);
    json(res, 201, { ok: true, payment: result });
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
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://billing.local");
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
      json(res, 200, { ok: true, ...result });
      return;
    }
    if (req.url.startsWith("/api/") || req.url.startsWith("/internal/") || req.url === "/health") {
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
server.listen(PORT, "0.0.0.0", () => console.log(`Hosting billing listening on ${PORT}`));

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
