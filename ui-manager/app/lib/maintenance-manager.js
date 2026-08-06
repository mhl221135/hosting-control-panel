const fs = require("fs");
const path = require("path");
const { validateOperations, validateRevisionRetention } = require("./wordpress-maintenance");
const { atomicWriteJson } = require("./safe-write");

const DEFAULT_SETTINGS = {
  enabled: false,
  weekday: 0,
  scheduleTime: "05:00",
  operations: ["transients", "trash", "cron"],
  revisionRetention: 5,
  lastScheduledDate: "",
};

class MaintenanceManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.backupManager = options.backupManager;
    this.jobManager = options.jobManager || null;
    this.siteProvider = options.siteProvider;
    this.runner = options.runner;
    this.afterRun = options.afterRun || (async () => {});
    this.settingsPath = path.join(this.dataDir, "maintenance-settings.json");
    this.statusPath = path.join(this.dataDir, "maintenance-status.json");
    this.inventoryPath = path.join(this.dataDir, "wordpress-inventory.json");
    this.currentPromise = null;
    this.timer = null;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.status = this.loadStatus();
    this.saveStatus();
    if (this.jobManager) {
      this.jobManager.register("wordpress.maintenance", async (context, payload) => {
        this.start(payload.sites, payload.operations, payload.trigger || "manual", context, {
          revisionRetention: payload.revisionRetention,
        });
        const status = await this.wait();
        return {
          ...status,
          ok: status.completed === status.total && status.results.every((result) => result.ok !== false),
          total: status.total,
          completed: status.completed,
          results: status.results,
          message: status.message,
        };
      });
      this.jobManager.register("wordpress.inventory", async (context, payload) => {
        const inventory = await this.runInventory(payload.sites, context);
        return {
          ok: inventory.results.every((result) => result.ok),
          total: inventory.results.length,
          completed: inventory.results.length,
          results: inventory.results.map((result) => ({
            domain: result.domain,
            ok: result.ok,
            core: result.core || "",
            pluginCount: result.plugins?.length || 0,
            themeCount: result.themes?.length || 0,
            message: result.message || "",
          })),
          message: inventory.results.every((result) => result.ok)
            ? "WordPress inventory completed"
            : "WordPress inventory completed with failures",
        };
      });
    }
  }

  emptyStatus() {
    return { running: false, total: 0, completed: 0, currentDomain: "", startedAt: "", finishedAt: "", message: "", results: [] };
  }

  loadStatus() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.statusPath, "utf8"));
      if (!stored.running) return stored;
      return { ...stored, running: false, currentDomain: "", finishedAt: new Date().toISOString(), message: "Maintenance was interrupted by a panel restart" };
    } catch {
      return this.emptyStatus();
    }
  }

  saveStatus() {
    fs.writeFileSync(this.statusPath, JSON.stringify(this.status, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  getStatus() {
    return JSON.parse(JSON.stringify(this.status));
  }

  readInventory() {
    try {
      const value = JSON.parse(fs.readFileSync(this.inventoryPath, "utf8"));
      return {
        generatedAt: String(value.generatedAt || ""),
        results: Array.isArray(value.results) ? value.results : [],
      };
    } catch {
      return { generatedAt: "", results: [] };
    }
  }

  readSettings() {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(this.settingsPath, "utf8")) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  updateSettings(patch) {
    const next = { ...this.readSettings() };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (patch.weekday !== undefined) {
      const weekday = Number(patch.weekday);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw Object.assign(new Error("Maintenance weekday is invalid"), { statusCode: 400 });
      next.weekday = weekday;
    }
    if (patch.scheduleTime !== undefined) {
      const value = String(patch.scheduleTime);
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw Object.assign(new Error("Maintenance time must use 24-hour HH:MM format"), { statusCode: 400 });
      next.scheduleTime = value;
    }
    if (patch.operations !== undefined) next.operations = validateOperations(patch.operations);
    if (patch.revisionRetention !== undefined) next.revisionRetention = validateRevisionRetention(patch.revisionRetention);
    if (patch.lastScheduledDate !== undefined) next.lastScheduledDate = String(patch.lastScheduledDate);
    atomicWriteJson(this.settingsPath, next, 0o600);
    return next;
  }

  startScheduler() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runScheduled().catch((error) => console.error("Scheduled maintenance failed:", error.message)), 60_000);
    this.timer.unref();
    this.runScheduled().catch((error) => console.error("Scheduled maintenance check failed:", error.message));
  }

  async runScheduled(now = new Date()) {
    const settings = this.readSettings();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const localTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (!settings.enabled || this.status.running || now.getDay() !== settings.weekday || localTime < settings.scheduleTime || settings.lastScheduledDate === localDate) return null;
    const sites = (await this.siteProvider()).filter((site) => site.state?.siteType === "wordpress" && site.state?.maintenanceEnabled);
    if (!sites.length) {
      this.updateSettings({ lastScheduledDate: localDate });
      return this.getStatus();
    }
    if (this.jobManager) {
      const job = this.enqueue(sites, settings.operations, "scheduler", "scheduled", `maintenance.schedule:${localDate}`, {
        revisionRetention: settings.revisionRetention,
      });
      const finished = await this.jobManager.wait(job.id);
      if (finished.completed === sites.length) this.updateSettings({ lastScheduledDate: localDate });
      return finished;
    }
    this.start(sites, settings.operations, "scheduled", null, { revisionRetention: settings.revisionRetention });
    const status = await this.wait();
    if (status.completed === sites.length) this.updateSettings({ lastScheduledDate: localDate });
    return status;
  }

  enqueue(sites, operations, operator = "system", trigger = "manual", idempotencyKey = "", options = {}) {
    if (!this.jobManager) throw new Error("Shared job manager is not configured");
    if (!Array.isArray(sites) || !sites.length) {
      throw Object.assign(new Error("Select at least one WordPress website"), { statusCode: 400 });
    }
    const selectedOperations = validateOperations(operations);
    const revisionRetention = validateRevisionRetention(options.revisionRetention);
    const targets = sites.map((site) => site.host);
    return this.jobManager.create({
      type: "wordpress.maintenance",
      label: `${trigger === "scheduled" ? "Scheduled" : "Manual"} maintenance for ${sites.length} website(s)`,
      operator,
      trigger,
      targets,
      conflicts: ["server-heavy", ...targets.map((domain) => `site:${domain}`)],
      idempotencyKey: idempotencyKey || `maintenance:${[...targets].sort().join(",")}:${[...selectedOperations].sort().join(",")}:revisions-${revisionRetention}`,
      payload: {
        trigger,
        operations: selectedOperations,
        revisionRetention,
        sites: sites.map((site) => ({
          host: site.host,
          directory: site.directory,
          redis: Boolean(site.redis),
        })),
      },
      total: sites.length,
    });
  }

  enqueueInventory(sites, operator = "system") {
    if (!this.jobManager) throw new Error("Shared job manager is not configured");
    if (!Array.isArray(sites) || !sites.length) {
      throw Object.assign(new Error("Select at least one WordPress website"), { statusCode: 400 });
    }
    const targets = sites.map((site) => site.host);
    return this.jobManager.create({
      type: "wordpress.inventory",
      label: `Inventory ${sites.length} WordPress website(s)`,
      operator,
      trigger: "manual",
      targets,
      conflicts: targets.map((domain) => `site:${domain}`),
      idempotencyKey: `wordpress.inventory:${[...targets].sort().join(",")}`,
      payload: {
        sites: sites.map((site) => ({ host: site.host, directory: site.directory })),
      },
      total: sites.length,
      cancellable: true,
      retryable: true,
    });
  }

  async runInventory(sites, context = null) {
    const results = [];
    context?.update({ total: sites.length, completed: 0, currentStep: "Reading WordPress versions" });
    for (const site of sites) {
      context?.checkpoint();
      context?.update({ currentStep: `Inventorying ${site.host}` });
      try {
        results.push({ domain: site.host, ok: true, ...(await this.runner.inventory(site)) });
      } catch (error) {
        results.push({
          domain: site.host,
          ok: false,
          message: String(error.stderr || error.message).replace(/[\r\n\t]+/g, " ").trim().slice(0, 500),
          plugins: [],
          themes: [],
        });
      }
      context?.update({
        completed: results.length,
        results: results.map((result) => ({
          domain: result.domain,
          ok: result.ok,
          core: result.core || "",
          pluginCount: result.plugins?.length || 0,
          themeCount: result.themes?.length || 0,
          message: result.message || "",
        })),
      });
    }
    const inventory = { generatedAt: new Date().toISOString(), results };
    const temporary = `${this.inventoryPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(inventory, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.inventoryPath);
    return inventory;
  }

  start(sites, operations, trigger = "manual", jobContext = null, options = {}) {
    if (this.status.running) throw Object.assign(new Error(`Maintenance is already running for ${this.status.currentDomain || "a website"}`), { statusCode: 409 });
    if (!Array.isArray(sites) || !sites.length) throw Object.assign(new Error("Select at least one WordPress website"), { statusCode: 400 });
    const selectedOperations = validateOperations(operations);
    this.status = { ...this.emptyStatus(), running: true, total: sites.length, startedAt: new Date().toISOString(), message: `${trigger === "scheduled" ? "Scheduled" : "Manual"} maintenance is running` };
    this.saveStatus();
    this.currentPromise = this.run(sites, selectedOperations, jobContext, {
      revisionRetention: validateRevisionRetention(options.revisionRetention),
    });
    return this.getStatus();
  }

  async run(sites, operations, jobContext = null, options = {}) {
    const touched = [];
    try {
      await this.backupManager.withLock({ type: "maintenance", label: "WordPress maintenance" }, async () => {
        for (const site of sites) {
          jobContext?.checkpoint();
          this.status.currentDomain = site.host;
          this.saveStatus();
          jobContext?.update({
            total: sites.length,
            completed: this.status.completed,
            currentStep: `Maintaining ${site.host}`,
            results: this.status.results,
          });
          try {
            const result = await this.runner.run(site, operations, options);
            this.status.results.push({ domain: site.host, ...result });
            touched.push(site.host);
          } catch (error) {
            this.status.results.push({ domain: site.host, ok: false, message: error.message, operations: [] });
          }
          this.status.completed += 1;
          this.saveStatus();
          jobContext?.update({ completed: this.status.completed, results: this.status.results });
        }
        if (touched.length) await this.afterRun(touched);
      });
      const failures = this.status.results.filter((result) => !result.ok).length;
      this.status.message = failures ? `Maintenance completed with ${failures} failed website(s)` : "Maintenance completed";
    } catch (error) {
      this.status.message = error.message;
    } finally {
      this.status.running = false;
      this.status.currentDomain = "";
      this.status.finishedAt = new Date().toISOString();
      this.saveStatus();
      this.currentPromise = null;
    }
  }

  async wait() {
    if (this.currentPromise) await this.currentPromise;
    return this.getStatus();
  }

  async previewRevisions(sites, retention) {
    if (!Array.isArray(sites) || !sites.length) throw Object.assign(new Error("Select at least one WordPress website"), { statusCode: 400 });
    const revisionRetention = validateRevisionRetention(retention);
    const results = [];
    for (const site of sites) {
      try {
        results.push({ domain: site.host, ok: true, ...(await this.runner.previewRevisions(site, revisionRetention)) });
      } catch (error) {
        results.push({ domain: site.host, ok: false, message: String(error.stderr || error.message) });
      }
    }
    return { revisionRetention, totalDelete: results.reduce((sum, result) => sum + (result.delete || 0), 0), results };
  }
}

module.exports = { DEFAULT_SETTINGS, MaintenanceManager };
