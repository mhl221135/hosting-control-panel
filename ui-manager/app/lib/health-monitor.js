const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function execFileResult(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout || 20_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.details = String(stderr || stdout || "").trim();
          reject(error);
          return;
        }
        resolve(String(stdout || ""));
      });
  });
}

function bounded(value, maximum = 500) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum);
}

function filesystemUsage(target) {
  if (typeof fs.statfsSync !== "function") return null;
  const stat = fs.statfsSync(target);
  const totalBytes = stat.blocks * stat.bsize;
  const freeBytes = stat.bavail * stat.bsize;
  const usedBytes = Math.max(0, totalBytes - stat.bfree * stat.bsize);
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: totalBytes ? Number(((usedBytes / totalBytes) * 100).toFixed(1)) : 0,
  };
}

function issue(key, type, target, severity, label, message) {
  return { key, type, target, severity, label: bounded(label, 160), message: bounded(message, 500) };
}

class HealthMonitor {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.websitesRoot = options.websitesRoot;
    this.backupsRoot = options.backupsRoot;
    this.settings = options.settings;
    this.notificationManager = options.notificationManager;
    this.statsCollector = options.statsCollector;
    this.npm = options.npm;
    this.exec = options.exec || execFileResult;
    this.now = options.now || (() => new Date());
    this.maxHistory = Number(options.maxHistory || 250);
    this.path = path.join(this.dataDir, "health-state.json");
    this.running = false;
    this.timer = null;
    this.state = this.load();
  }

  load() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.path, "utf8"));
      return {
        lastCheckAt: stored.lastCheckAt || "",
        lastCheckDurationMs: Number(stored.lastCheckDurationMs || 0),
        active: stored.active && typeof stored.active === "object" ? stored.active : {},
        history: Array.isArray(stored.history) ? stored.history : [],
      };
    } catch {
      return { lastCheckAt: "", lastCheckDurationMs: 0, active: {}, history: [] };
    }
  }

  persist() {
    this.state.history = this.state.history.slice(0, this.maxHistory);
    const temporary = `${this.path}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...this.state }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, this.path);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => {
      console.error(`Health monitor failed: ${bounded(error.message)}`);
    }), 30_000);
    this.timer.unref?.();
    setTimeout(() => this.tick().catch(() => {}), 20_000).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const settings = this.settings.read();
    if (!settings.enabled || this.running) return;
    const last = this.state.lastCheckAt ? new Date(this.state.lastCheckAt).getTime() : 0;
    if (Date.now() - last < settings.intervalMinutes * 60_000) return;
    await this.run();
  }

  async checkContainers(settings) {
    const findings = [];
    await Promise.all(settings.requiredContainers.map(async (name) => {
      try {
        const output = await this.exec("docker", ["inspect", "--format", "{{json .State}}", name]);
        const state = JSON.parse(output.trim());
        if (!state.Running) {
          findings.push(issue(`container:${name}`, "container", name, "critical", `Container ${name} is down`,
            `State is ${state.Status || "not running"}${state.Error ? `: ${state.Error}` : ""}.`));
        } else if (state.Health?.Status === "unhealthy") {
          findings.push(issue(`container:${name}`, "container", name, "critical", `Container ${name} is unhealthy`,
            "Docker health status is unhealthy."));
        } else if (state.Restarting) {
          findings.push(issue(`container:${name}`, "container", name, "warning", `Container ${name} is restarting`,
            "Docker reports that the container is restarting."));
        }
      } catch (error) {
        findings.push(issue(`container:${name}`, "container", name, "critical", `Container ${name} is unavailable`,
          error.details || error.message));
      }
    }));
    return findings;
  }

  checkFilesystem(label, target, settings) {
    try {
      const usage = filesystemUsage(target);
      if (!usage) return [];
      const severity = usage.usedPercent >= settings.diskCriticalPercent
        ? "critical"
        : usage.usedPercent >= settings.diskWarningPercent ? "warning" : "";
      return severity ? [issue(`disk:${label}`, "disk", label, severity, `${label} disk is ${severity}`,
        `${usage.usedPercent}% used; ${(usage.freeBytes / 1024 ** 3).toFixed(1)} GB available.`)] : [];
    } catch (error) {
      return [issue(`disk:${label}`, "disk", label, "warning", `${label} disk check failed`, error.message)];
    }
  }

  async checkMySql() {
    try {
      await this.exec("docker", ["exec", "hosting-db", "sh", "-c",
        "mysqladmin -uroot -p\"$MYSQL_ROOT_PASSWORD\" ping --silent"], { timeout: 15_000 });
      return [];
    } catch (error) {
      return [issue("service:mysql", "service", "MySQL", "critical", "MySQL is unavailable",
        error.details || error.message)];
    }
  }

  async checkOpcache(settings) {
    try {
      const runtime = await this.statsCollector.runtime(true);
      const opcache = runtime.opcache;
      if (!opcache?.enabled) {
        return [issue("service:opcache", "cache", "OPcache", "warning", "OPcache status is unavailable",
          runtime.warnings?.find((item) => item.startsWith("OPcache")) || "OPcache is disabled or did not respond.")];
      }
      const total = Number(opcache.memory?.usedBytes || 0) + Number(opcache.memory?.freeBytes || 0);
      const usedPercent = total ? (Number(opcache.memory?.usedBytes || 0) / total) * 100 : 0;
      if (opcache.cacheFull) {
        return [issue("service:opcache", "cache", "OPcache", "critical", "OPcache is full",
          `${usedPercent.toFixed(1)}% of shared memory is used.`)];
      }
      if (opcache.restartPending || opcache.restartInProgress) {
        return [issue("service:opcache", "cache", "OPcache", "warning", "OPcache restart is pending",
          `${usedPercent.toFixed(1)}% of shared memory is used.`)];
      }
      if (usedPercent >= settings.opcacheWarningPercent) {
        return [issue("service:opcache", "cache", "OPcache", "warning", "OPcache memory is high",
          `${usedPercent.toFixed(1)}% of shared memory is used.`)];
      }
      return [];
    } catch (error) {
      return [issue("service:opcache", "cache", "OPcache", "warning", "OPcache check failed", error.message)];
    }
  }

  async checkNpm(settings) {
    try {
      const [hosts, certificates] = await Promise.all([this.npm.listHosts(), this.npm.listCertificates()]);
      const activeIds = new Set(hosts.filter((host) => host.enabled !== false && Number(host.certificate_id) > 0)
        .map((host) => Number(host.certificate_id)));
      const findings = [];
      for (const certificate of certificates.filter((item) => activeIds.has(Number(item.id)))) {
        const expiresAt = new Date(certificate.expires_on || certificate.expiresAt || "").getTime();
        if (!Number.isFinite(expiresAt)) continue;
        const days = Math.floor((expiresAt - this.now().getTime()) / 86_400_000);
        const severity = days <= settings.certificateCriticalDays
          ? "critical"
          : days <= settings.certificateWarningDays ? "warning" : "";
        if (!severity) continue;
        const domains = Array.isArray(certificate.domain_names) ? certificate.domain_names.join(", ") : certificate.nice_name || `#${certificate.id}`;
        findings.push(issue(`certificate:${certificate.id}`, "certificate", domains, severity,
          `Certificate ${severity === "critical" ? "expires soon" : "needs attention"}`,
          `${domains} expires in ${days} day${days === 1 ? "" : "s"}.`));
      }
      return findings;
    } catch (error) {
      return [issue("service:npm-api", "service", "Nginx Proxy Manager", "critical", "Public proxy API is unavailable",
        error.message)];
    }
  }

  async collect(settings) {
    const groups = await Promise.all([
      this.checkContainers(settings),
      this.checkMySql(),
      this.checkOpcache(settings),
      this.checkNpm(settings),
      Promise.resolve(this.checkFilesystem("Websites", this.websitesRoot, settings)),
      Promise.resolve(this.checkFilesystem("Backups", this.backupsRoot, settings)),
    ]);
    return groups.flat().sort((left, right) => left.key.localeCompare(right.key));
  }

  transition(finding, transition, at, previous = null) {
    const event = {
      id: crypto.randomUUID(),
      key: finding.key,
      type: finding.type,
      target: finding.target,
      transition,
      severity: transition === "resolved" ? "success" : finding.severity,
      label: transition === "resolved" ? `Recovered: ${finding.label}` : finding.label,
      message: transition === "resolved" ? `Recovered after: ${finding.message}` : finding.message,
      at,
      notificationId: "",
    };
    const delivery = this.notificationManager.enqueueEvent({
      eventType: "health",
      eventId: event.id,
      dedupeKey: `health:${event.id}`,
      severity: event.severity,
      label: event.label,
      status: transition,
      targets: [event.target],
      message: event.message,
      finishedAt: at,
      respectSeverityFilter: false,
    });
    event.notificationId = delivery?.id || "";
    this.state.history.unshift(event);
    return { ...finding, openedAt: previous?.openedAt || at, lastSeenAt: at, lastTransitionAt: at };
  }

  reconcile(findings, at) {
    const found = new Map(findings.map((item) => [item.key, item]));
    const next = {};
    for (const finding of findings) {
      const previous = this.state.active[finding.key];
      const changed = previous && (previous.severity !== finding.severity || previous.message !== finding.message);
      if (!previous || changed) next[finding.key] = this.transition(finding, previous ? "updated" : "opened", at, previous);
      else next[finding.key] = { ...previous, ...finding, lastSeenAt: at };
    }
    for (const previous of Object.values(this.state.active)) {
      if (!found.has(previous.key)) this.transition(previous, "resolved", at, previous);
    }
    this.state.active = next;
  }

  delivery(id) {
    return id ? this.notificationManager.publicDelivery(id) : null;
  }

  publicState() {
    const active = Object.values(this.state.active).sort((left, right) =>
      String(left.severity).localeCompare(String(right.severity)) || left.key.localeCompare(right.key));
    return {
      settings: this.settings.read(),
      running: this.running,
      lastCheckAt: this.state.lastCheckAt,
      lastCheckDurationMs: this.state.lastCheckDurationMs,
      active,
      history: this.state.history.slice(0, 100).map((event) => ({ ...event, delivery: this.delivery(event.notificationId) })),
      summary: {
        critical: active.filter((item) => item.severity === "critical").length,
        warning: active.filter((item) => item.severity === "warning").length,
        healthy: active.length === 0 && Boolean(this.state.lastCheckAt),
      },
    };
  }

  async run() {
    if (this.running) throw Object.assign(new Error("A health check is already running"), { statusCode: 409 });
    this.running = true;
    const started = Date.now();
    try {
      const settings = this.settings.read();
      const findings = await this.collect(settings);
      const at = this.now().toISOString();
      this.reconcile(findings, at);
      this.state.lastCheckAt = at;
      this.state.lastCheckDurationMs = Date.now() - started;
      this.persist();
      return this.publicState();
    } finally {
      this.running = false;
    }
  }
}

module.exports = { filesystemUsage, HealthMonitor };
