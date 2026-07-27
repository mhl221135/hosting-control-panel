const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function bounded(value, maximum = 500) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum);
}

function commandFrom(text) {
  const match = String(text || "").trim().match(/^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s+(.+))?$/i);
  if (!match) return null;
  return { name: match[1].toLowerCase(), argument: bounded(match[2], 253).toLowerCase() };
}

class TelegramCommandManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.settings = options.settings;
    this.healthProvider = options.healthProvider;
    this.siteProvider = options.siteProvider;
    this.jobProvider = options.jobProvider;
    this.backupProvider = options.backupProvider;
    this.purgeProvider = options.purgeProvider;
    this.fetch = options.fetch || global.fetch;
    this.now = options.now || (() => new Date());
    this.pollIntervalMs = Number(options.pollIntervalMs || 5_000);
    this.maxHistory = Number(options.maxHistory || 250);
    this.confirmationTtlMs = Number(options.confirmationTtlMs || 120_000);
    this.challengeCode = options.challengeCode || (() => crypto.randomBytes(3).toString("hex"));
    this.path = path.join(this.dataDir, "telegram-command-state.json");
    this.timer = null;
    this.active = false;
    this.running = false;
    this.rateLimits = new Map();
    this.confirmations = new Map();
    this.state = this.load();
  }

  load() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.path, "utf8"));
      return {
        offset: Math.max(0, Number(stored.offset || 0)),
        lastPollAt: bounded(stored.lastPollAt, 40),
        lastError: bounded(stored.lastError, 300),
        history: Array.isArray(stored.history) ? stored.history.slice(0, this.maxHistory) : [],
      };
    } catch {
      return { offset: 0, lastPollAt: "", lastError: "", history: [] };
    }
  }

  persist() {
    const temporary = `${this.path}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...this.state }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, this.path);
  }

  start() {
    if (this.active) return;
    this.active = true;
    const tick = async () => {
      await this.poll().catch((error) => {
        this.state.lastError = bounded(error.message, 300);
        this.persist();
      });
      if (!this.active) return;
      this.timer = setTimeout(tick, this.pollIntervalMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, 2_000);
    this.timer.unref?.();
  }

  stop() {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  publicState() {
    const settings = this.settings.resolved();
    return {
      enabled: settings.telegramCommandsEnabled,
      configured: Boolean(settings.telegramEnabled && settings.telegramBotToken
        && settings.telegramChatIds.length && settings.telegramCommandUserIds.length),
      mutationsEnabled: settings.telegramMutationsEnabled,
      lastPollAt: this.state.lastPollAt,
      lastError: this.state.lastError,
      handled: this.state.history.filter((item) => item.result === "replied").length,
      denied: this.state.history.filter((item) => item.result === "denied").length,
    };
  }

  allowed(settings, chatId, userId) {
    return settings.telegramChatIds.includes(String(chatId))
      && settings.telegramCommandUserIds.includes(String(userId));
  }

  rateLimited(userId) {
    const now = this.now().getTime();
    const recent = (this.rateLimits.get(String(userId)) || []).filter((timestamp) => now - timestamp < 60_000);
    if (recent.length >= 10) {
      this.rateLimits.set(String(userId), recent);
      return true;
    }
    recent.push(now);
    this.rateLimits.set(String(userId), recent);
    return false;
  }

  audit(input) {
    const updateId = Number(input.updateId || 0);
    if (updateId && this.state.history.some((item) => item.updateId === updateId)) return;
    this.state.history.unshift({
      at: this.now().toISOString(),
      updateId,
      chatId: bounded(input.chatId, 40),
      userId: bounded(input.userId, 40),
      command: bounded(input.command, 32),
      target: bounded(input.target, 253),
      result: bounded(input.result, 80),
    });
    this.state.history = this.state.history.slice(0, this.maxHistory);
  }

  primarySite(domain) {
    if (!DOMAIN_PATTERN.test(domain)) return null;
    return this.siteProvider().find((item) =>
      String(item.host).toLowerCase() === domain && !item.isAlias) || null;
  }

  confirmationKey(chatId, userId) {
    return `${chatId}:${userId}`;
  }

  helpMessage(settings) {
    const commands = ["Available commands:", "/status", "/site example.com"];
    if (settings.telegramMutationsEnabled) {
      commands.push("/backup example.com", "/purge example.com", "/confirm code", "/cancel");
    }
    return commands.join("\n");
  }

  statusMessage(settings) {
    const health = this.healthProvider();
    const sites = this.siteProvider().filter((site) => !site.isAlias);
    const jobs = this.jobProvider();
    const activeJobs = jobs.filter((job) => ["queued", "running", "cancelling"].includes(job.status));
    const failedJobs = jobs.filter((job) => job.status === "failed"
      && Date.now() - new Date(job.finishedAt || job.createdAt).getTime() < 86_400_000);
    const healthLabel = health.summary?.healthy
      ? "healthy"
      : `${Number(health.summary?.critical || 0)} critical, ${Number(health.summary?.warning || 0)} warning`;
    return [
      settings.installationName,
      `Server: ${settings.serverName}`,
      `Health: ${healthLabel}`,
      `Sites: ${sites.length}`,
      `Active jobs: ${activeJobs.length}`,
      `Failed jobs (24h): ${failedJobs.length}`,
      `Last health check: ${health.lastCheckAt || "not run"}`,
      settings.panelUrl ? `Panel: ${settings.panelUrl}` : "",
    ].filter(Boolean).join("\n");
  }

  siteMessage(domain) {
    if (!DOMAIN_PATTERN.test(domain)) return "Usage: /site example.com";
    const sites = this.siteProvider();
    const site = sites.find((item) => String(item.host).toLowerCase() === domain);
    if (!site) return `Site not found: ${domain}`;
    const state = site.state || {};
    const type = state.siteType || "unknown";
    return [
      site.host,
      `Type: ${type}${site.isAlias ? " (alias)" : ""}`,
      `Pool: ${site.poolTier || site.poolName || "none"}`,
      `OPcache: ${state.opcache === false ? "disabled" : "enabled"}`,
      `FastCGI: ${state.fastcgiCache ? "enabled" : "disabled"}`,
      `Redis: ${type === "wordpress" ? (state.redis ? "enabled" : "disabled") : "not applicable"}`,
      `Daily backup: ${state.backupEnabled ? "enabled" : "disabled"}`,
      `Daily images: ${type === "wordpress" && state.imageOptimizationEnabled ? "enabled" : "disabled"}`,
    ].join("\n");
  }

  response(command, settings) {
    if (!command || command.name === "help" || command.name === "start") {
      return this.helpMessage(settings);
    }
    if (command.name === "status") return this.statusMessage(settings);
    if (command.name === "site") return this.siteMessage(command.argument);
    return `Unknown command.\n${this.helpMessage(settings)}`;
  }

  requestMutation(command, settings, chatId, userId) {
    if (!settings.telegramMutationsEnabled) {
      return { text: "Telegram backup and purge commands are disabled in panel settings.", result: "mutation-disabled" };
    }
    const site = this.primarySite(command.argument);
    if (!site) {
      return { text: `Primary site not found: ${command.argument || "(missing domain)"}`, result: "site-not-found" };
    }
    const code = this.challengeCode().toLowerCase();
    this.confirmations.set(this.confirmationKey(chatId, userId), {
      code,
      action: command.name,
      domain: site.host,
      expiresAt: this.now().getTime() + this.confirmationTtlMs,
    });
    return {
      text: [
        `Confirm ${command.name} for ${site.host}.`,
        `Send /confirm ${code} within ${Math.ceil(this.confirmationTtlMs / 60_000)} minutes.`,
        "Send /cancel to discard it.",
      ].join("\n"),
      result: "confirmation-issued",
    };
  }

  async confirmMutation(command, chatId, userId) {
    const key = this.confirmationKey(chatId, userId);
    const pending = this.confirmations.get(key);
    if (!pending) return { text: "No pending operation to confirm.", result: "confirmation-missing", target: "" };
    if (pending.expiresAt <= this.now().getTime()) {
      this.confirmations.delete(key);
      return { text: "The confirmation expired. Submit the operation again.", result: "confirmation-expired", target: pending.domain };
    }
    if (!command.argument || command.argument !== pending.code) {
      return { text: "Confirmation code does not match.", result: "confirmation-rejected", target: pending.domain };
    }
    this.confirmations.delete(key);
    try {
      const operator = `telegram:${userId}`;
      const result = pending.action === "backup"
        ? await this.backupProvider(pending.domain, operator)
        : await this.purgeProvider(pending.domain, operator);
      return {
        text: bounded(result?.message || `${pending.action} started for ${pending.domain}`, 1000),
        result: "executed",
        target: pending.domain,
      };
    } catch (error) {
      return {
        text: `Operation failed: ${bounded(error.message, 500)}`,
        result: "failed",
        target: pending.domain,
      };
    }
  }

  cancelMutation(chatId, userId) {
    const key = this.confirmationKey(chatId, userId);
    const pending = this.confirmations.get(key);
    this.confirmations.delete(key);
    return {
      text: pending ? `Cancelled ${pending.action} for ${pending.domain}.` : "No pending operation to cancel.",
      result: pending ? "cancelled" : "confirmation-missing",
      target: pending?.domain || "",
    };
  }

  async send(settings, chatId, text) {
    const response = await this.fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3500), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Telegram command reply failed with HTTP ${response.status}`);
  }

  async handle(update, settings) {
    const message = update?.message;
    const chatId = message?.chat?.id;
    const userId = message?.from?.id;
    const command = commandFrom(message?.text);
    if (!command || chatId === undefined || userId === undefined) return;
    if (!this.allowed(settings, chatId, userId)) {
      this.audit({ updateId: update.update_id, chatId, userId, command: command.name, target: command.argument, result: "denied" });
      return;
    }
    if (this.rateLimited(userId)) {
      this.audit({ updateId: update.update_id, chatId, userId, command: command.name, target: command.argument, result: "rate-limited" });
      await this.send(settings, chatId, "Command rate limit reached. Try again in one minute.");
      return;
    }
    let outcome;
    if (command.name === "backup" || command.name === "purge") {
      outcome = this.requestMutation(command, settings, chatId, userId);
    } else if (command.name === "confirm") {
      outcome = await this.confirmMutation(command, chatId, userId);
    } else if (command.name === "cancel") {
      outcome = this.cancelMutation(chatId, userId);
    } else {
      outcome = { text: this.response(command, settings), result: "replied", target: command.argument };
    }
    this.audit({
      updateId: update.update_id,
      chatId,
      userId,
      command: command.name,
      target: outcome.target ?? command.argument,
      result: outcome.result,
    });
    await this.send(settings, chatId, outcome.text);
  }

  async poll() {
    const settings = this.settings.resolved();
    if (this.running || !settings.telegramCommandsEnabled || !settings.telegramEnabled
      || !settings.telegramBotToken || !settings.telegramChatIds.length || !settings.telegramCommandUserIds.length) return;
    this.running = true;
    try {
      const url = new URL(`https://api.telegram.org/bot${settings.telegramBotToken}/getUpdates`);
      url.searchParams.set("offset", String(this.state.offset));
      url.searchParams.set("limit", "20");
      url.searchParams.set("timeout", "0");
      url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
      const response = await this.fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Telegram command poll failed with HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload.ok || !Array.isArray(payload.result)) throw new Error("Telegram returned an invalid command response");
      for (const update of payload.result) {
        await this.handle(update, settings);
        this.state.offset = Math.max(this.state.offset, Number(update.update_id || 0) + 1);
      }
      this.state.lastPollAt = this.now().toISOString();
      this.state.lastError = "";
      this.persist();
    } finally {
      this.running = false;
    }
  }
}

module.exports = { commandFrom, TelegramCommandManager };
