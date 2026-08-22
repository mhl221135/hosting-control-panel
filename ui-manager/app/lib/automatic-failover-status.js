const fs = require("fs");
const path = require("path");

const STATUSES = new Set([
  "activation-failed", "activating", "awaiting-fence", "blocked-recovery",
  "blocked-sync", "disabled", "healthy", "invalid-config", "preview-failed",
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

module.exports = { readAutomaticFailoverStatus };
