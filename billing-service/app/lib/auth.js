const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { email, validationError } = require("./validation");

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 8;

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  return {
    salt: encode(salt),
    hash: encode(crypto.scryptSync(password, salt, 64)),
  };
}

function verifyPassword(password, account) {
  const expected = Buffer.from(account.hash, "base64url");
  const actual = crypto.scryptSync(String(password || ""), Buffer.from(account.salt, "base64url"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? [] : [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
  }));
}

class AuthStore {
  constructor(dataDir) {
    this.accountPath = path.join(dataDir, "admin-account.json");
    this.sessions = new Map();
    this.attempts = new Map();
    this.ensureAccount();
  }

  ensureAccount() {
    if (fs.existsSync(this.accountPath)) return;
    const accountEmail = email(process.env.BILLING_ADMIN_EMAIL || "billing-admin@example.com");
    const password = String(process.env.BILLING_ADMIN_PASSWORD || "");
    if (password.length < 12) throw new Error("BILLING_ADMIN_PASSWORD must contain at least 12 characters");
    fs.writeFileSync(this.accountPath, JSON.stringify({
      email: accountEmail,
      ...hashPassword(password),
      updatedAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
  }

  read() {
    return JSON.parse(fs.readFileSync(this.accountPath, "utf8"));
  }

  clientKey(req, loginEmail) {
    const address = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
    return `${address}:${String(loginEmail || "").toLowerCase()}`;
  }

  login(req, loginEmail, password) {
    const normalized = String(loginEmail || "").trim().toLowerCase();
    const key = this.clientKey(req, normalized);
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    const attempts = (this.attempts.get(key) || []).filter((stamp) => stamp > cutoff);
    if (attempts.length >= LOGIN_LIMIT) throw Object.assign(new Error("Too many login attempts. Try again later."), { statusCode: 429 });
    const account = this.read();
    const valid = normalized === account.email && verifyPassword(password, account);
    if (!valid) {
      attempts.push(Date.now());
      this.attempts.set(key, attempts);
      throw Object.assign(new Error("Invalid email or password"), { statusCode: 401 });
    }
    this.attempts.delete(key);
    const session = {
      id: crypto.randomBytes(32).toString("base64url"),
      csrf: crypto.randomBytes(32).toString("base64url"),
      email: account.email,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  session(req) {
    const id = cookies(req).billing_session;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      if (id) this.sessions.delete(id);
      return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  }

  cookie(req, id, clear = false) {
    const secure = String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https" ? "; Secure" : "";
    return `billing_session=${clear ? "" : encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_TTL_MS / 1000}${secure}`;
  }

  logout(req) {
    const session = this.session(req);
    if (session) this.sessions.delete(session.id);
  }

  update(session, currentPassword, nextEmail, nextPassword) {
    const account = this.read();
    if (!verifyPassword(currentPassword, account)) throw validationError("Current password is incorrect");
    const normalized = email(nextEmail);
    if (String(nextPassword || "") && String(nextPassword).length < 12) {
      throw validationError("New password must contain at least 12 characters");
    }
    account.email = normalized;
    if (nextPassword) Object.assign(account, hashPassword(String(nextPassword)));
    account.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.accountPath, JSON.stringify(account, null, 2), { mode: 0o600 });
    session.email = normalized;
    session.csrf = crypto.randomBytes(32).toString("base64url");
    return session;
  }
}

function apiAuthorized(req) {
  const configured = String(process.env.BILLING_API_TOKEN || "");
  const match = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
  if (configured.length < 32 || !match) return false;
  const left = Buffer.from(configured);
  const right = Buffer.from(match[1]);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = { AuthStore, apiAuthorized };
