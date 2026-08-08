const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const TIMEOUT = 15_000;

// ── Receiver adapter ──
// Reads systemd state for the backup receiver service. Missing systemd is
// a warning in development but must not silently pass on standby.
class StandbyReceiverAdapter {
  constructor(options = {}) {
    this.unit = options.unit || "hosting-backup-receiver.service";
    this.timer = options.timer || "hosting-backup-receiver.timer";
    this.dataDir = options.dataDir;
    this.backupsRoot = options.backupsRoot;
  }

  async receiverState() {
    try {
      const service = await this.systemctl("show", this.unit);
      const active = this.parseProp(service, "ActiveState");
      const sub = this.parseProp(service, "SubState");
      const lastSuccess = this.parseProp(service, "ExecMainExitTimestamp");
      return {
        active: active !== "inactive" && active !== "failed",
        sub: sub || "unknown",
        lastSuccess: lastSuccess ? Date.parse(lastSuccess) : 0,
        verifiedCount: this.countVerifiedSets(),
        error: "",
      };
    } catch (error) {
      return {
        active: false,
        sub: "unreachable",
        lastSuccess: 0,
        verifiedCount: this.countVerifiedSets(),
        error: String(error.message).slice(0, 200),
      };
    }
  }

  async timerState() {
    try {
      const out = await this.systemctl("show", this.timer);
      const enabled = this.parseProp(out, "UnitFileState") !== "disabled";
      const nextRun = this.parseProp(out, "TimersMonotonic");
      return { enabled, nextRun: Math.round(Number(nextRun || 0) / 1_000_000) };
    } catch {
      return { enabled: false, nextRun: 0 };
    }
  }

  async hasActiveLock() {
    try {
      const lockFile = path.join(this.dataDir || "/tmp", "receiver.lock");
      return fs.existsSync(lockFile);
    } catch {
      return false;
    }
  }

  async systemctl(...args) {
    try {
      const { stdout } = await execFileAsync("systemctl", ["--no-pager", ...args], {
        timeout: 10_000, maxBuffer: 64 * 1024,
      });
      return String(stdout);
    } catch {
      return "";
    }
  }

  parseProp(text, property) {
    const match = new RegExp(`^${property}=(.+)$`, "m").exec(text || "");
    return match ? match[1].trim() : "";
  }

  countVerifiedSets() {
    try {
      if (!this.backupsRoot || !fs.existsSync(this.backupsRoot)) return 0;
      let count = 0;
      for (const entry of fs.readdirSync(this.backupsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "app-data" || entry.name === "exports") continue;
        const siteDir = path.join(this.backupsRoot, entry.name);
        if (!fs.statSync(siteDir).isDirectory()) continue;
        for (const setEntry of fs.readdirSync(siteDir)) {
          const setDir = path.join(siteDir, setEntry);
          if (fs.existsSync(path.join(setDir, "manifest.json"))) count += 1;
        }
      }
      return count;
    } catch {
      return 0;
    }
  }
}

// ── Docker adapter ──
class StandbyDockerAdapter {
  constructor(options = {}) {
    this.imageNames = options.imageNames || []; // injected from server.js
  }

  async daemonAvailable() {
    try {
      await execFileAsync("docker", ["info", "--format", "ok"], { timeout: TIMEOUT });
      return true;
    } catch {
      return false;
    }
  }

  async imageCheck() {
    const results = [];
    for (const name of this.imageNames) {
      try {
        await execFileAsync("docker", ["image", "inspect", name],
          { timeout: TIMEOUT, maxBuffer: 64 * 1024 });
        results.push({ name, exists: true });
      } catch {
        results.push({ name, exists: false });
      }
    }
    return results;
  }
}

// ── Ingress readiness ──
class StandbyIngressAdapter {
  constructor(options = {}) {
    this.mode = options.mode || "";
    this.sourcesRoot = options.sourcesRoot || "";
  }

  checks() {
    const results = [];
    if (this.mode === "cloudflare_tunnel") {
      const tokenConfigured = Boolean(process.env.CLOUDFLARED_TUNNEL_URL);
      results.push({
        status: tokenConfigured ? "pass" : "fail",
        reason: tokenConfigured
          ? "Tunnel: cloudflared tunnel URL is configured"
          : "Tunnel: cloudflared tunnel URL is not configured",
      });
    } else if (this.mode === "direct_npm") {
      results.push({
        status: "warning",
        reason: "Ingress: direct NPM (verify NPM container/image readiness on the primary)",
      });
    } else {
      results.push({ status: "warning", reason: "Ingress mode is not configured" });
    }
    return results;
  }
}

module.exports = {
  StandbyDockerAdapter,
  StandbyIngressAdapter,
  StandbyReceiverAdapter,
};