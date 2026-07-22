const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const TERMINAL = new Set(["succeeded", "failed", "partially_succeeded", "cancelled"]);
const SEVERITY = {
  failed: "failure",
  partially_succeeded: "warning",
  cancelled: "warning",
  succeeded: "success",
};

function bounded(value, maximum = 500) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum);
}

function safeProviderError(error, settings) {
  let message = bounded(error?.message || error, 300);
  for (const secret of [settings.telegramBotToken, settings.smtpPassword].filter(Boolean)) {
    message = message.split(secret).join("[redacted]");
  }
  return message;
}

class NotificationManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.settings = options.settings;
    this.fetch = options.fetch || global.fetch;
    this.createTransport = options.createTransport || nodemailer.createTransport;
    this.now = options.now || (() => new Date());
    this.retryDelaysMs = options.retryDelaysMs || [60_000, 300_000, 1_800_000];
    this.maxHistory = Number(options.maxHistory || 500);
    this.path = path.join(this.dataDir, "notification-deliveries.json");
    this.processing = false;
    this.timer = null;
    this.jobManager = null;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.deliveries = this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.path, "utf8"));
      return Array.isArray(data.deliveries) ? data.deliveries : [];
    } catch {
      return [];
    }
  }

  persist() {
    this.deliveries = this.deliveries
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, this.maxHistory);
    const temporary = `${this.path}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, deliveries: this.deliveries }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, this.path);
  }

  start(jobManager) {
    if (this.jobManager) return;
    this.jobManager = jobManager;
    this.changed = (id) => this.captureJob(id);
    jobManager.events.on("changed", this.changed);
    this.timer = setInterval(() => this.process().catch((error) => {
      console.error(`Notification queue failed: ${bounded(error.message)}`);
    }), 5_000);
    this.timer.unref?.();
    this.process().catch(() => {});
  }

  stop() {
    if (this.jobManager && this.changed) this.jobManager.events.off("changed", this.changed);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.jobManager = null;
  }

  severityEnabled(settings, severity) {
    return Boolean(settings[`severity${severity[0].toUpperCase()}${severity.slice(1)}`]);
  }

  channelSeverityEnabled(settings, channel, severity) {
    const suffix = `${severity[0].toUpperCase()}${severity.slice(1)}`;
    if (settings[`${channel}UseGlobalSeverity`] !== false) return this.severityEnabled(settings, severity);
    return Boolean(settings[`${channel}Severity${suffix}`]);
  }

  enabledChannels(settings, severity = "warning", respectSeverityFilter = true) {
    const channels = [];
    if (settings.telegramEnabled && settings.telegramBotToken && settings.telegramChatIds.length
      && (!respectSeverityFilter || this.channelSeverityEnabled(settings, "telegram", severity))) channels.push("telegram");
    if (settings.smtpEnabled && settings.smtpHost && settings.smtpFrom && settings.smtpRecipients.length
      && (!respectSeverityFilter || this.channelSeverityEnabled(settings, "smtp", severity))) channels.push("smtp");
    return channels;
  }

  captureJob(id) {
    const job = this.jobManager?.publicJob(this.jobManager.get(id));
    if (!job || !TERMINAL.has(job.status)) return;
    const severity = SEVERITY[job.status];
    const settings = this.settings.resolved();
    const channels = this.enabledChannels(settings, severity);
    if (!channels.length) return;
    const dedupeKey = `job:${job.id}:${job.status}`;
    if (this.deliveries.some((item) => item.dedupeKey === dedupeKey)) return;
    const timestamp = this.now().toISOString();
    const delivery = {
      id: crypto.randomUUID(),
      dedupeKey,
      eventType: "job",
      eventId: job.id,
      severity,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      nextAttemptAt: timestamp,
      channels: Object.fromEntries(channels.map((channel) => [channel, {
        status: "queued",
        attempts: 0,
        lastAttemptAt: "",
        error: "",
      }])),
      event: {
        label: bounded(job.label, 160),
        status: job.status,
        operator: bounded(job.operator, 160),
        targets: (job.targets || []).slice(0, 10).map((target) => bounded(target, 160)),
        message: bounded(job.message, 500),
        error: bounded(job.error, 500),
        finishedAt: job.finishedAt,
      },
    };
    this.deliveries.push(delivery);
    this.persist();
    this.recordOnJob(delivery);
    this.process().catch(() => {});
  }

  enqueueEvent(input) {
    const severity = ["critical", "failure", "warning", "success"].includes(input.severity)
      ? input.severity
      : "warning";
    const settings = this.settings.resolved();
    const channels = this.enabledChannels(settings, severity, input.respectSeverityFilter !== false);
    if (!channels.length) return null;
    const dedupeKey = bounded(input.dedupeKey || `${input.eventType}:${input.eventId}`, 240);
    const existing = this.deliveries.find((item) => item.dedupeKey === dedupeKey);
    if (existing) return this.publicDelivery(existing.id);
    const timestamp = this.now().toISOString();
    const delivery = {
      id: crypto.randomUUID(),
      dedupeKey,
      eventType: bounded(input.eventType || "event", 80),
      eventId: bounded(input.eventId || crypto.randomUUID(), 160),
      severity,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      nextAttemptAt: timestamp,
      channels: Object.fromEntries(channels.map((channel) => [channel, {
        status: "queued", attempts: 0, lastAttemptAt: "", error: "",
      }])),
      event: {
        label: bounded(input.label, 160),
        status: bounded(input.status || "event", 80),
        operator: "system",
        targets: (input.targets || []).slice(0, 10).map((target) => bounded(target, 160)),
        message: bounded(input.message, 500),
        error: bounded(input.error, 500),
        finishedAt: input.finishedAt || timestamp,
      },
    };
    this.deliveries.push(delivery);
    this.persist();
    this.process().catch(() => {});
    return this.publicDelivery(delivery.id);
  }

  publicDelivery(id) {
    const delivery = this.deliveries.find((item) => item.id === id);
    if (!delivery) return null;
    return {
      id: delivery.id,
      status: delivery.status,
      severity: delivery.severity,
      updatedAt: delivery.updatedAt,
      channels: Object.fromEntries(Object.entries(delivery.channels).map(([name, value]) => [name, {
        status: value.status,
        attempts: value.attempts,
        error: value.error,
      }])),
    };
  }

  formatMessage(event, settings, test = false) {
    const title = test ? "Notification test" : `${event.severity.toUpperCase()}: ${event.label}`;
    const lines = [
      settings.installationName,
      title,
      `Server: ${settings.serverName}`,
      `Status: ${event.status}`,
    ];
    if (event.targets?.length) lines.push(`Site: ${event.targets.join(", ")}`);
    if (event.message) lines.push(`Result: ${event.message}`);
    if (event.error) lines.push(`Error: ${event.error}`);
    lines.push(`Time: ${event.finishedAt || this.now().toISOString()}`);
    if (settings.panelUrl) lines.push(`Panel: ${settings.panelUrl}`);
    return lines.join("\n").slice(0, 3500);
  }

  async sendTelegram(settings, message) {
    for (const chatId of settings.telegramChatIds) {
      const response = await this.fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Telegram rejected the message with HTTP ${response.status}`);
    }
  }

  async sendSmtp(settings, message) {
    const transport = this.createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: settings.smtpSecure,
      requireTLS: !settings.smtpSecure,
      auth: settings.smtpUsername
        ? { user: settings.smtpUsername, pass: settings.smtpPassword }
        : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
    });
    await transport.sendMail({
      from: settings.smtpFrom,
      to: settings.smtpRecipients.join(", "),
      subject: `[${settings.installationName}] ${message.split("\n")[1] || "Notification"}`.slice(0, 180),
      text: message,
    });
    transport.close?.();
  }

  async test(channel) {
    const settings = this.settings.resolved();
    const event = {
      severity: "success",
      label: "Notification test",
      status: "test",
      targets: [],
      message: "The notification channel is configured correctly.",
      error: "",
      finishedAt: this.now().toISOString(),
    };
    const message = this.formatMessage(event, settings, true);
    if (channel === "telegram") {
      if (!settings.telegramBotToken || !settings.telegramChatIds.length) throw new Error("Telegram token and chat ID are required");
      await this.sendTelegram(settings, message);
    } else if (channel === "smtp") {
      if (!settings.smtpHost || !settings.smtpFrom || !settings.smtpRecipients.length) throw new Error("SMTP host, sender, and recipient are required");
      await this.sendSmtp(settings, message);
    } else {
      throw Object.assign(new Error("Unknown notification channel"), { statusCode: 400 });
    }
    return { ok: true, message: `${channel === "smtp" ? "SMTP" : "Telegram"} test notification sent.` };
  }

  async process() {
    if (this.processing) return;
    this.processing = true;
    try {
      const now = this.now();
      const pending = this.deliveries.filter((item) =>
        ["queued", "retrying"].includes(item.status) && new Date(item.nextAttemptAt) <= now);
      for (const delivery of pending) await this.deliver(delivery);
    } finally {
      this.processing = false;
    }
  }

  async deliver(delivery) {
    const settings = this.settings.resolved();
    const message = this.formatMessage({ ...delivery.event, severity: delivery.severity }, settings);
    for (const [channel, result] of Object.entries(delivery.channels)) {
      if (result.status === "sent") continue;
      result.attempts += 1;
      result.lastAttemptAt = this.now().toISOString();
      try {
        if (channel === "telegram") await this.sendTelegram(settings, message);
        else if (channel === "smtp") await this.sendSmtp(settings, message);
        result.status = "sent";
        result.error = "";
      } catch (error) {
        result.status = result.attempts > this.retryDelaysMs.length ? "failed" : "retrying";
        result.error = safeProviderError(error, settings);
      }
    }
    const results = Object.values(delivery.channels);
    if (results.every((item) => item.status === "sent")) {
      delivery.status = "delivered";
      delivery.nextAttemptAt = "";
    } else if (results.every((item) => ["sent", "failed"].includes(item.status))) {
      delivery.status = "failed";
      delivery.nextAttemptAt = "";
    } else {
      delivery.status = "retrying";
      const attempts = Math.max(...results.filter((item) => item.status === "retrying").map((item) => item.attempts));
      const delay = this.retryDelaysMs[Math.max(0, attempts - 1)] || this.retryDelaysMs.at(-1);
      delivery.nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
    }
    delivery.updatedAt = this.now().toISOString();
    this.persist();
    this.recordOnJob(delivery);
  }

  recordOnJob(delivery) {
    if (!this.jobManager || delivery.eventType !== "job") return;
    this.jobManager.recordNotification(delivery.eventId, {
      id: delivery.id,
      severity: delivery.severity,
      status: delivery.status,
      updatedAt: delivery.updatedAt,
      channels: Object.fromEntries(Object.entries(delivery.channels).map(([name, value]) => [name, {
        status: value.status,
        attempts: value.attempts,
        error: value.error,
      }])),
    });
  }
}

module.exports = { NotificationManager };
