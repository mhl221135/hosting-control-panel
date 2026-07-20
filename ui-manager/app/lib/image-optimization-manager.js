const fs = require("fs");
const path = require("path");

class ImageOptimizationManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.backupManager = options.backupManager;
    this.optimizer = options.optimizer;
    this.statusPath = path.join(this.dataDir, "image-optimization-status.json");
    this.currentPromise = null;
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
