const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function stringList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/);
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

class NotificationSettings {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.settingsPath = path.join(dataDir, "notification-settings.json");
    this.keyPath = path.join(dataDir, "notification-settings.key");
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
    try {
      return JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
    } catch {
      return {};
    }
  }

  resolved() {
    const stored = this.readStored();
    const severityFailure = stored.severityFailure !== false;
    const severityWarning = stored.severityWarning !== false;
    const severitySuccess = Boolean(stored.severitySuccess);
    return {
      installationName: stored.installationName || process.env.NOTIFICATION_INSTALLATION_NAME || "Hosting control panel",
      serverName: stored.serverName || process.env.NOTIFICATION_SERVER_NAME || "hosting-server",
      panelUrl: stored.panelUrl || process.env.PANEL_PUBLIC_URL || "",
      telegramEnabled: Boolean(stored.telegramEnabled),
      telegramBotToken: this.decrypt(stored.telegramBotToken) || process.env.TELEGRAM_BOT_TOKEN || "",
      telegramChatIds: stringList(stored.telegramChatIds || process.env.TELEGRAM_CHAT_IDS),
      smtpEnabled: Boolean(stored.smtpEnabled),
      smtpHost: stored.smtpHost || process.env.NOTIFICATION_SMTP_HOST || "",
      smtpPort: Number(stored.smtpPort || process.env.NOTIFICATION_SMTP_PORT || 587),
      smtpSecure: Boolean(stored.smtpSecure),
      smtpUsername: stored.smtpUsername || process.env.NOTIFICATION_SMTP_USERNAME || "",
      smtpPassword: this.decrypt(stored.smtpPassword) || process.env.NOTIFICATION_SMTP_PASSWORD || "",
      smtpFrom: stored.smtpFrom || process.env.NOTIFICATION_SMTP_FROM || "",
      smtpRecipients: stringList(stored.smtpRecipients || process.env.NOTIFICATION_SMTP_RECIPIENTS),
      severityFailure,
      severityWarning,
      severitySuccess,
      telegramUseGlobalSeverity: stored.telegramUseGlobalSeverity !== false,
      telegramSeverityFailure: stored.telegramSeverityFailure ?? severityFailure,
      telegramSeverityWarning: stored.telegramSeverityWarning ?? severityWarning,
      telegramSeveritySuccess: stored.telegramSeveritySuccess ?? severitySuccess,
      smtpUseGlobalSeverity: stored.smtpUseGlobalSeverity !== false,
      smtpSeverityFailure: stored.smtpSeverityFailure ?? severityFailure,
      smtpSeverityWarning: stored.smtpSeverityWarning ?? severityWarning,
      smtpSeveritySuccess: stored.smtpSeveritySuccess ?? severitySuccess,
    };
  }

  publicView() {
    const settings = this.resolved();
    return {
      installationName: settings.installationName,
      serverName: settings.serverName,
      panelUrl: settings.panelUrl,
      telegramEnabled: settings.telegramEnabled,
      telegramBotTokenConfigured: Boolean(settings.telegramBotToken),
      telegramChatIds: settings.telegramChatIds.join("\n"),
      smtpEnabled: settings.smtpEnabled,
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      smtpSecure: settings.smtpSecure,
      smtpUsername: settings.smtpUsername,
      smtpPasswordConfigured: Boolean(settings.smtpPassword),
      smtpFrom: settings.smtpFrom,
      smtpRecipients: settings.smtpRecipients.join("\n"),
      severityFailure: settings.severityFailure,
      severityWarning: settings.severityWarning,
      severitySuccess: settings.severitySuccess,
      telegramUseGlobalSeverity: settings.telegramUseGlobalSeverity,
      telegramSeverityFailure: settings.telegramSeverityFailure,
      telegramSeverityWarning: settings.telegramSeverityWarning,
      telegramSeveritySuccess: settings.telegramSeveritySuccess,
      smtpUseGlobalSeverity: settings.smtpUseGlobalSeverity,
      smtpSeverityFailure: settings.smtpSeverityFailure,
      smtpSeverityWarning: settings.smtpSeverityWarning,
      smtpSeveritySuccess: settings.smtpSeveritySuccess,
    };
  }

  update(payload) {
    const current = this.readStored();
    const next = {
      installationName: String(payload.installationName || current.installationName || "Hosting control panel").trim(),
      serverName: String(payload.serverName || current.serverName || "hosting-server").trim(),
      panelUrl: String(payload.panelUrl ?? current.panelUrl ?? "").trim().replace(/\/$/, ""),
      telegramEnabled: Boolean(payload.telegramEnabled),
      telegramBotToken: payload.clearTelegramBotToken
        ? ""
        : payload.telegramBotToken
          ? this.encrypt(payload.telegramBotToken)
          : current.telegramBotToken || "",
      telegramChatIds: stringList(payload.telegramChatIds),
      smtpEnabled: Boolean(payload.smtpEnabled),
      smtpHost: String(payload.smtpHost ?? current.smtpHost ?? "").trim(),
      smtpPort: Number(payload.smtpPort || current.smtpPort || 587),
      smtpSecure: Boolean(payload.smtpSecure),
      smtpUsername: String(payload.smtpUsername ?? current.smtpUsername ?? "").trim(),
      smtpPassword: payload.clearSmtpPassword
        ? ""
        : payload.smtpPassword
          ? this.encrypt(payload.smtpPassword)
          : current.smtpPassword || "",
      smtpFrom: String(payload.smtpFrom ?? current.smtpFrom ?? "").trim(),
      smtpRecipients: stringList(payload.smtpRecipients),
      severityFailure: Boolean(payload.severityFailure),
      severityWarning: Boolean(payload.severityWarning),
      severitySuccess: Boolean(payload.severitySuccess),
      telegramUseGlobalSeverity: payload.telegramUseGlobalSeverity === undefined
        ? current.telegramUseGlobalSeverity !== false : Boolean(payload.telegramUseGlobalSeverity),
      telegramSeverityFailure: payload.telegramSeverityFailure === undefined
        ? current.telegramSeverityFailure ?? Boolean(payload.severityFailure) : Boolean(payload.telegramSeverityFailure),
      telegramSeverityWarning: payload.telegramSeverityWarning === undefined
        ? current.telegramSeverityWarning ?? Boolean(payload.severityWarning) : Boolean(payload.telegramSeverityWarning),
      telegramSeveritySuccess: payload.telegramSeveritySuccess === undefined
        ? current.telegramSeveritySuccess ?? Boolean(payload.severitySuccess) : Boolean(payload.telegramSeveritySuccess),
      smtpUseGlobalSeverity: payload.smtpUseGlobalSeverity === undefined
        ? current.smtpUseGlobalSeverity !== false : Boolean(payload.smtpUseGlobalSeverity),
      smtpSeverityFailure: payload.smtpSeverityFailure === undefined
        ? current.smtpSeverityFailure ?? Boolean(payload.severityFailure) : Boolean(payload.smtpSeverityFailure),
      smtpSeverityWarning: payload.smtpSeverityWarning === undefined
        ? current.smtpSeverityWarning ?? Boolean(payload.severityWarning) : Boolean(payload.smtpSeverityWarning),
      smtpSeveritySuccess: payload.smtpSeveritySuccess === undefined
        ? current.smtpSeveritySuccess ?? Boolean(payload.severitySuccess) : Boolean(payload.smtpSeveritySuccess),
      updatedAt: new Date().toISOString(),
    };

    if (!next.installationName || next.installationName.length > 100) {
      throw validationError("Installation name must contain 1 to 100 characters");
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(next.serverName)) {
      throw validationError("Server name must contain only letters, numbers, dots, underscores, or hyphens");
    }
    if (next.panelUrl && !/^https?:\/\/[^\s]+$/.test(next.panelUrl)) {
      throw validationError("Panel URL must start with http:// or https://");
    }
    if (!Number.isInteger(next.smtpPort) || next.smtpPort < 1 || next.smtpPort > 65535) {
      throw validationError("SMTP port must be between 1 and 65535");
    }
    if (next.telegramEnabled && (!(this.decrypt(next.telegramBotToken) || process.env.TELEGRAM_BOT_TOKEN) || !next.telegramChatIds.length)) {
      throw validationError("Telegram requires a bot token and at least one chat ID");
    }
    if (next.smtpEnabled && (!next.smtpHost || !next.smtpFrom || !next.smtpRecipients.length)) {
      throw validationError("SMTP requires a host, sender, and at least one recipient");
    }
    const emails = [next.smtpFrom, ...next.smtpRecipients].filter(Boolean);
    if (emails.some((email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
      throw validationError("Enter valid SMTP sender and recipient addresses");
    }

    fs.writeFileSync(this.settingsPath, JSON.stringify(next, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    return this.publicView();
  }
}

module.exports = { NotificationSettings, stringList };
