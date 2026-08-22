const fs = require("fs");
const path = require("path");

const STATUSES = new Set([
  "activation-failed", "activating", "awaiting-fence", "blocked-recovery",
  "blocked-host-qualification", "blocked-sync", "disabled", "healthy", "invalid-config", "preview-failed",
  "blocked-stale-recovery",
  "primary-unreachable", "promoted", "promoted-unreachable",
  "threshold-reached", "awaiting-unreachable-grace",
]);
const RECOVERY_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function unavailable() {
  return {
    available: false,
    status: "unavailable",
    checkedAt: null,
    failures: 0,
    threshold: 0,
    recoveryId: null,
    fencePolicy: null,
    unreachableSince: null,
    recoveryAgeSeconds: null,
  };
}

function readAutomaticFailoverStatus(dataDir) {
  const filename = path.join(dataDir, "automatic-failover-state.json");
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return unavailable();
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    const checkedAt = typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt))
      ? value.checkedAt
      : null;
    const failures = boundedInteger(value.failures, 0, 1_000_000);
    const threshold = boundedInteger(value.threshold, 3, 30);
    if (value.version !== 1 || !STATUSES.has(value.status) || !checkedAt || failures === null) return unavailable();
    return {
      available: true,
      status: value.status,
      checkedAt,
      failures,
      threshold: threshold || 0,
      recoveryId: typeof value.recoveryId === "string" && RECOVERY_ID.test(value.recoveryId)
        ? value.recoveryId
        : null,
      fencePolicy: ["receipt", "unreachable"].includes(value.fencePolicy) ? value.fencePolicy : null,
      unreachableSince: typeof value.unreachableSince === "string" && Number.isFinite(Date.parse(value.unreachableSince))
        ? value.unreachableSince
        : null,
      recoveryAgeSeconds: boundedInteger(value.recoveryAgeSeconds, 0, 86_400),
    };
  } catch {
    return unavailable();
  }
}

const ALERTS = {
  "primary-unreachable": ["warning", "Primary server is unreachable", "Automatic failover detection has started."],
  "threshold-reached": ["warning", "Failover threshold reached", "Monitor mode did not activate the standby."],
  "awaiting-fence": ["warning", "Failover is awaiting fencing", "Automatic activation requires a valid fencing receipt."],
  "awaiting-unreachable-grace": ["warning", "Failover grace period active", "The primary remains unreachable; activation is waiting for the configured grace period."],
  activating: ["failure", "Automatic failover is activating", "The standby is being promoted and public ingress is being switched."],
  promoted: ["failure", "Standby promoted", "The standby is now the active hosting server."],
  "promoted-unreachable": ["failure", "Standby promoted after primary outage", "Emergency failover completed under the accepted unreachable-primary policy."],
  "blocked-sync": ["failure", "Failover blocked by replication", "The synchronized recovery state is not ready for promotion."],
  "blocked-recovery": ["failure", "Failover recovery is unavailable", "A valid prepared database recovery point was not found."],
  "blocked-stale-recovery": ["failure", "Failover recovery is stale", "The prepared database recovery point is older than the configured limit."],
  "blocked-host-qualification": ["failure", "Failover host list is not qualified", "The active hostname allowlist does not match its qualification receipt."],
  "preview-failed": ["failure", "Failover preview failed", "Local promotion or Cloudflare cutover validation failed."],
  "activation-failed": ["failure", "Automatic failover failed", "Standby activation did not complete."],
  "invalid-config": ["failure", "Automatic failover configuration is invalid", "The watchdog rejected its current configuration."],
};

class AutomaticFailoverNotificationMonitor {
  constructor({ dataDir, notificationManager, intervalMs = 5_000 }) {
    this.dataDir = dataDir;
    this.notificationManager = notificationManager;
    this.intervalMs = intervalMs;
    this.path = path.join(dataDir, "automatic-failover-notification-state.json");
    this.timer = null;
  }

  previousStatus() {
    try {
      const value = JSON.parse(fs.readFileSync(this.path, "utf8"));
      return STATUSES.has(value.status) ? value.status : "";
    } catch {
      return "";
    }
  }

  persist(status) {
    const temporary = `${this.path}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, status }), { mode: 0o600 });
    fs.renameSync(temporary, this.path);
  }

  tick() {
    const current = readAutomaticFailoverStatus(this.dataDir);
    if (!current.available) return null;
    const previous = this.previousStatus();
    if (current.status === previous) return null;
    let alert = ALERTS[current.status];
    if (current.status === "healthy" && previous && previous !== "healthy" && previous !== "disabled") {
      alert = ["success", "Primary connectivity recovered", "The automatic failover watchdog returned to healthy state."];
    }
    this.persist(current.status);
    if (!alert) return null;
    const [severity, label, message] = alert;
    return this.notificationManager.enqueueEvent({
      eventType: "automatic-failover",
      eventId: current.checkedAt,
      dedupeKey: `automatic-failover:${current.status}:${current.checkedAt}`,
      severity,
      label,
      status: current.status,
      targets: current.recoveryId ? [current.recoveryId] : [],
      message,
      finishedAt: current.checkedAt,
      respectSeverityFilter: false,
    });
  }

  start() {
    if (this.timer) return;
    const run = () => {
      try {
        this.tick();
      } catch (error) {
        console.error(`Automatic failover notification check failed: ${String(error?.message || error).replace(/[\r\n\t]+/g, " ").slice(0, 300)}`);
      }
    };
    run();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { AutomaticFailoverNotificationMonitor, readAutomaticFailoverStatus };
