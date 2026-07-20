const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 8;

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(password, salt, 64);
  return {
    salt: encode(salt),
    hash: encode(derived),
  };
}

function verifyPassword(password, stored) {
  const salt = Buffer.from(stored.salt, "base64url");
  const expected = Buffer.from(stored.hash, "base64url");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return cookies;
}

class AuthStore {
  constructor(dataDir) {
    this.accountPath = path.join(dataDir, "admin-account.json");
    this.sessions = new Map();
    this.loginAttempts = new Map();
    this.ensureAccount();
  }

  ensureAccount() {
    if (fs.existsSync(this.accountPath)) return;
    const email = String(process.env.UI_ADMIN_EMAIL || "admin@example.com").trim().toLowerCase();
    const password = String(process.env.UI_ADMIN_PASSWORD || "change-this-before-deploy");
    const passwordData = hashPassword(password);
    fs.writeFileSync(
      this.accountPath,
      JSON.stringify(
        {
          email,
          ...passwordData,
          mustChangePassword: !process.env.UI_ADMIN_PASSWORD || password === "change-this-before-deploy",
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );
  }

  readAccount() {
    return JSON.parse(fs.readFileSync(this.accountPath, "utf8"));
  }

  writeAccount(account) {
    fs.writeFileSync(this.accountPath, JSON.stringify(account, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  clientKey(req, email = "") {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    return `${forwarded || req.socket.remoteAddress || "unknown"}:${email.toLowerCase()}`;
  }

  isLoginLimited(key) {
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    const attempts = (this.loginAttempts.get(key) || []).filter((stamp) => stamp > cutoff);
    this.loginAttempts.set(key, attempts);
    return attempts.length >= LOGIN_LIMIT;
  }

  recordLogin(key, success) {
    if (success) {
      this.loginAttempts.delete(key);
      return;
    }
    const attempts = this.loginAttempts.get(key) || [];
    attempts.push(Date.now());
    this.loginAttempts.set(key, attempts);
  }

  login(req, email, password) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const key = this.clientKey(req, normalizedEmail);
    if (this.isLoginLimited(key)) {
      const error = new Error("Too many login attempts. Try again later.");
      error.statusCode = 429;
      throw error;
    }

    const account = this.readAccount();
    const valid =
      normalizedEmail === account.email &&
      typeof password === "string" &&
      verifyPassword(password, account);
    this.recordLogin(key, valid);
    if (!valid) {
      const error = new Error("Invalid email or password");
      error.statusCode = 401;
      throw error;
    }

    const id = crypto.randomBytes(32).toString("base64url");
    const session = {
      id,
      email: account.email,
      csrf: crypto.randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.sessions.set(id, session);
    return { session, mustChangePassword: Boolean(account.mustChangePassword) };
  }

  getSession(req) {
    const id = parseCookies(req).ui_session;
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      if (id) this.sessions.delete(id);
      return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  }

  cookie(req, sessionId) {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
    const secure = forwardedProto === "https" ? "; Secure" : "";
    return `ui_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
  }

  clearCookie(req) {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
    const secure = forwardedProto === "https" ? "; Secure" : "";
    return `ui_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  }

  logout(req) {
    const session = this.getSession(req);
    if (session) this.sessions.delete(session.id);
  }

  updateAccount(session, currentPassword, email, newPassword) {
    const account = this.readAccount();
    if (!verifyPassword(String(currentPassword || ""), account)) {
      const error = new Error("Current password is incorrect");
      error.statusCode = 400;
      throw error;
    }

    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
      const error = new Error("Enter a valid email address");
      error.statusCode = 400;
      throw error;
    }

    account.email = normalizedEmail;
    if (newPassword) {
      if (String(newPassword).length < 12) {
        const error = new Error("New password must be at least 12 characters");
        error.statusCode = 400;
        throw error;
      }
      Object.assign(account, hashPassword(String(newPassword)));
    }
    account.mustChangePassword = false;
    account.updatedAt = new Date().toISOString();
    this.writeAccount(account);
    session.email = account.email;
    session.csrf = crypto.randomBytes(32).toString("base64url");
    return { email: account.email, csrf: session.csrf };
  }
}

module.exports = { AuthStore };
