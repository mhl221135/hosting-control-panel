const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

class IntegrationSettings {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.settingsPath = path.join(dataDir, "integration-settings.json");
    this.keyPath = path.join(dataDir, "integration-settings.key");
    this.key = this.loadKey();
  }

  loadKey() {
    if (process.env.UI_SETTINGS_KEY) {
      return crypto.createHash("sha256").update(process.env.UI_SETTINGS_KEY).digest();
    }
    if (fs.existsSync(this.keyPath)) {
      return Buffer.from(fs.readFileSync(this.keyPath, "utf8").trim(), "base64url");
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, key.toString("base64url"), { encoding: "utf8", mode: 0o600 });
    return key;
  }

  encrypt(value) {
    if (!value) return "";
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
  }

  decrypt(value) {
    if (!value) return "";
    try {
      const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } catch {
      return "";
    }
  }

  readStored() {
    if (!fs.existsSync(this.settingsPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
    } catch {
      return {};
    }
  }

  resolved() {
    const stored = this.readStored();
    return {
      npmApiUrl: stored.npmApiUrl || process.env.NPM_API_URL || "http://hosting-npm:81/api",
      npmIdentity: stored.npmIdentity || process.env.NPM_IDENTITY || "",
      npmSecret: this.decrypt(stored.npmSecret) || process.env.NPM_SECRET || "",
      acmeEmail: stored.acmeEmail || process.env.ACME_EMAIL || "",
      cloudflareToken: this.decrypt(stored.cloudflareToken) || process.env.CLOUDFLARE_API_TOKEN || "",
      cloudflareSecurityToken: this.decrypt(stored.cloudflareSecurityToken)
        || process.env.CLOUDFLARE_SECURITY_API_TOKEN || "",
      cloudflareAccountId: stored.cloudflareAccountId || process.env.CLOUDFLARE_ACCOUNT_ID || "",
      ipinfoToken: this.decrypt(stored.ipinfoToken) || process.env.IPINFO_TOKEN || "",
      mysqlContainer: stored.mysqlContainer || process.env.MYSQL_CONTAINER || "hosting-db",
      mysqlSitePrefix: stored.mysqlSitePrefix || process.env.MYSQL_SITE_PREFIX || "yogali00_",
    };
  }

  publicView() {
    const settings = this.resolved();
    return {
      npmApiUrl: settings.npmApiUrl,
      npmIdentity: settings.npmIdentity,
      npmSecretConfigured: Boolean(settings.npmSecret),
      acmeEmail: settings.acmeEmail,
      cloudflareTokenConfigured: Boolean(settings.cloudflareToken),
      cloudflareSecurityTokenConfigured: Boolean(settings.cloudflareSecurityToken),
      cloudflareAccountId: settings.cloudflareAccountId,
      ipinfoTokenConfigured: Boolean(settings.ipinfoToken),
      mysqlContainer: settings.mysqlContainer,
      mysqlSitePrefix: settings.mysqlSitePrefix,
    };
  }

  update(payload) {
    const current = this.readStored();
    const next = {
      npmApiUrl: String(payload.npmApiUrl || current.npmApiUrl || "http://hosting-npm:81/api").trim().replace(/\/$/, ""),
      npmIdentity: String(payload.npmIdentity || current.npmIdentity || "").trim().toLowerCase(),
      acmeEmail: String(payload.acmeEmail || current.acmeEmail || process.env.ACME_EMAIL || "").trim().toLowerCase(),
      npmSecret: payload.clearNpmSecret
        ? ""
        : payload.npmSecret
          ? this.encrypt(payload.npmSecret)
          : current.npmSecret || "",
      cloudflareToken: payload.clearCloudflareToken
        ? ""
        : payload.cloudflareToken
          ? this.encrypt(payload.cloudflareToken)
          : current.cloudflareToken || "",
      cloudflareSecurityToken: payload.clearCloudflareSecurityToken
        ? ""
        : payload.cloudflareSecurityToken
          ? this.encrypt(payload.cloudflareSecurityToken)
          : current.cloudflareSecurityToken || "",
      cloudflareAccountId: String(
        payload.cloudflareAccountId || current.cloudflareAccountId || process.env.CLOUDFLARE_ACCOUNT_ID || "",
      ).trim().toLowerCase(),
      ipinfoToken: payload.clearIpinfoToken
        ? ""
        : payload.ipinfoToken
          ? this.encrypt(payload.ipinfoToken)
          : current.ipinfoToken || "",
      mysqlContainer: String(payload.mysqlContainer || current.mysqlContainer || "hosting-db").trim(),
      mysqlSitePrefix: String(payload.mysqlSitePrefix || current.mysqlSitePrefix || "yogali00_")
        .trim()
        .toLowerCase(),
      updatedAt: new Date().toISOString(),
    };
    if (!/^https?:\/\//.test(next.npmApiUrl)) {
      const error = new Error("NPM API URL must start with http:// or https://");
      error.statusCode = 400;
      throw error;
    }
    if (next.acmeEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next.acmeEmail)) {
      const error = new Error("Enter a valid ACME email");
      error.statusCode = 400;
      throw error;
    }
    if (next.cloudflareAccountId && !/^[a-f0-9]{32}$/.test(next.cloudflareAccountId)) {
      const error = new Error("Cloudflare Account ID must be a 32-character hexadecimal value");
      error.statusCode = 400;
      throw error;
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(next.mysqlContainer)) {
      const error = new Error("MySQL container name is invalid");
      error.statusCode = 400;
      throw error;
    }
    if (!/^[a-z0-9_]{1,16}$/.test(next.mysqlSitePrefix)) {
      const error = new Error("Database prefix must contain up to 16 lowercase letters, numbers or underscores");
      error.statusCode = 400;
      throw error;
    }
    fs.writeFileSync(this.settingsPath, JSON.stringify(next, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    return this.publicView();
  }
}

module.exports = { IntegrationSettings };
