const fs = require("fs");
const path = require("path");

const DEFAULT_SETTINGS = {
  enabled: false,
  scheduleTime: "04:00",
  lastScheduledDate: "",
};

class ImageOptimizationManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.backupManager = options.backupManager;
    this.optimizer = options.optimizer;
    this.siteProvider = options.siteProvider;
    this.statusPath = path.join(this.dataDir, "image-optimization-status.json");
    this.settingsPath = path.join(this.dataDir, "image-optimization-settings.json");
    this.currentPromise = null;
    this.lastScheduleAttemptAt = 0;
    this.timer = null;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.status = this.loadStatus();
    this.saveStatus();
  }

  loadStatus() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.statusPath, "utf8"));
      if (stored.running) {
        return {
          ...stored,
          running: false,
          currentDomain: "",
          finishedAt: new Date().toISOString(),
          message: "Image optimization was interrupted by a panel restart",
        };
      }
      return stored;
    } catch {
      return this.emptyStatus();
    }
  }

  emptyStatus() {
    return {
      running: false,
      total: 0,
      completed: 0,
      currentDomain: "",
      startedAt: "",
      finishedAt: "",
      message: "",
      results: [],
    };
  }

  saveStatus() {
    fs.writeFileSync(this.statusPath, JSON.stringify(this.status, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
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
    if (patch.scheduleTime !== undefined) {
      const value = String(patch.scheduleTime);
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        const error = new Error("Image optimization time must use 24-hour HH:MM format");
        error.statusCode = 400;
        throw error;
      }
      next.scheduleTime = value;
    }
    if (patch.lastScheduledDate !== undefined) next.lastScheduledDate = String(patch.lastScheduledDate);
    fs.writeFileSync(this.settingsPath, JSON.stringify(next, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    return next;
  }

  startScheduler() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runScheduled().catch((error) => {
      console.error("Scheduled image optimization failed:", error.message);
    }), 30_000);
    this.timer.unref();
    this.runScheduled().catch((error) => console.error("Scheduled image optimization check failed:", error.message));
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runScheduled(now = new Date()) {
    const settings = this.readSettings();
    if (!settings.enabled || this.status.running || this.backupManager.status?.().busy) return null;
    const localDate = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    const localTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (localTime < settings.scheduleTime || settings.lastScheduledDate === localDate) return null;
    if (Date.now() - this.lastScheduleAttemptAt < 15 * 60 * 1000) return null;
    this.lastScheduleAttemptAt = Date.now();

    const provided = this.siteProvider ? await this.siteProvider() : [];
    const sites = provided
      .filter((site) => !site.isAlias && !site.isWwwAlias && site.state?.imageOptimizationEnabled)
      .map((site) => ({ host: site.host, directory: site.directory || site.host }));
    if (!sites.length) {
      this.updateSettings({ lastScheduledDate: localDate });
      return { ok: true, results: [] };
    }
    this.start(sites);
    const status = await this.wait();
    if (status.results.length === sites.length) this.updateSettings({ lastScheduledDate: localDate });
    return status;
  }

  start(sites) {
    if (this.status.running) {
      const error = new Error(`Image optimization is already running for ${this.status.currentDomain || "a website"}`);
      error.statusCode = 409;
      throw error;
    }
    if (!Array.isArray(sites) || !sites.length) {
      const error = new Error("No primary websites are configured");
      error.statusCode = 400;
      throw error;
    }
    this.status = {
      ...this.emptyStatus(),
      running: true,
      total: sites.length,
      startedAt: new Date().toISOString(),
      message: "Image optimization is running",
    };
    this.saveStatus();
    this.currentPromise = this.run(sites);
    return this.getStatus();
  }

  async run(sites) {
    try {
      await this.backupManager.withLock(
        { type: "images-all", label: "Optimize images for all websites" },
        async () => {
          for (const site of sites) {
            this.status.currentDomain = site.host;
            this.saveStatus();
            try {
              const result = await this.optimizer(site.directory);
              this.status.results.push({ domain: site.host, ok: true, ...result });
            } catch (error) {
              this.status.results.push({ domain: site.host, ok: false, message: error.message });
            }
            this.status.completed += 1;
            this.saveStatus();
          }
        },
      );
      const failures = this.status.results.filter((result) => !result.ok).length;
      this.status.message = failures
        ? `Image optimization completed with ${failures} failed website(s)`
        : "Image optimization completed";
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

module.exports = { ImageOptimizationManager };
