const fs = require("fs");
const path = require("path");
const { validateOperations } = require("./wordpress-maintenance");

const DEFAULT_SETTINGS = {
  enabled: false,
  weekday: 0,
  scheduleTime: "05:00",
  operations: ["transients", "trash", "cron"],
  lastScheduledDate: "",
};

class MaintenanceManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.backupManager = options.backupManager;
    this.siteProvider = options.siteProvider;
    this.runner = options.runner;
    this.afterRun = options.afterRun || (async () => {});
    this.settingsPath = path.join(this.dataDir, "maintenance-settings.json");
    this.statusPath = path.join(this.dataDir, "maintenance-status.json");
    this.currentPromise = null;
    this.timer = null;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.status = this.loadStatus();
    this.saveStatus();
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
    if (patch.lastScheduledDate !== undefined) next.lastScheduledDate = String(patch.lastScheduledDate);
    fs.writeFileSync(this.settingsPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
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
    this.start(sites, settings.operations, "scheduled");
    const status = await this.wait();
    if (status.completed === sites.length) this.updateSettings({ lastScheduledDate: localDate });
    return status;
  }

  start(sites, operations, trigger = "manual") {
    if (this.status.running) throw Object.assign(new Error(`Maintenance is already running for ${this.status.currentDomain || "a website"}`), { statusCode: 409 });
    if (!Array.isArray(sites) || !sites.length) throw Object.assign(new Error("Select at least one WordPress website"), { statusCode: 400 });
    const selectedOperations = validateOperations(operations);
    this.status = { ...this.emptyStatus(), running: true, total: sites.length, startedAt: new Date().toISOString(), message: `${trigger === "scheduled" ? "Scheduled" : "Manual"} maintenance is running` };
    this.saveStatus();
    this.currentPromise = this.run(sites, selectedOperations);
    return this.getStatus();
  }

  async run(sites, operations) {
    const touched = [];
    try {
      await this.backupManager.withLock({ type: "maintenance", label: "WordPress maintenance" }, async () => {
        for (const site of sites) {
          this.status.currentDomain = site.host;
          this.saveStatus();
          try {
            const result = await this.runner.run(site, operations);
            this.status.results.push({ domain: site.host, ...result });
            touched.push(site.host);
          } catch (error) {
            this.status.results.push({ domain: site.host, ok: false, message: error.message, operations: [] });
          }
          this.status.completed += 1;
          this.saveStatus();
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
}

module.exports = { DEFAULT_SETTINGS, MaintenanceManager };
