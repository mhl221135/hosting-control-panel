const fs = require("fs");
const path = require("path");
const { atomicWriteJson } = require("./safe-write");

function boundedNumber(value, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(maximum, Math.floor(number)) : 0;
}

function classify(replication, peer) {
  const folders = Array.isArray(replication?.folders) ? replication.folders : [];
  const errors = folders.reduce((sum, folder) => sum + boundedNumber(folder.errors, 1_000_000), 0);
  const needed = folders.reduce((sum, folder) => sum + boundedNumber(folder.needFiles, 1_000_000_000), 0);
  const recoveryAgeMinutes = replication?.recovery ? boundedNumber(replication.recovery.ageMinutes, 1_000_000) : null;
  if (!peer?.configured) return { status: "unconfigured", reason: "Authenticated peer pairing is not configured" };
  if (!peer.reachable || !peer.identityMatched) return { status: "critical", reason: "Authenticated peer is unreachable or its identity does not match" };
  if (!replication?.available || !replication.peerConnected) return { status: "critical", reason: "Replication peer is disconnected" };
  if (errors) return { status: "critical", reason: `${errors} replication errors reported` };
  if (recoveryAgeMinutes === null || recoveryAgeMinutes > 120) return { status: "critical", reason: "Database recovery point is unavailable or older than 120 minutes" };
  if (needed || !replication.exact || recoveryAgeMinutes > 75) return { status: "warning", reason: needed ? `${needed} files are pending` : "Replication or database recovery is behind" };
  return { status: "healthy", reason: "Peer, folders, and database recovery are current" };
}

class ReplicationHistory {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    this.path = path.join(this.dataDir, "replication-history.json");
    this.now = options.now || (() => Date.now());
    this.limit = Math.max(24, Math.min(2016, Number(options.limit || 288)));
    this.minimumIntervalMs = Math.max(60_000, Number(options.minimumIntervalMs || 300_000));
    this.notificationManager = options.notificationManager;
    this.entries = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.path, "utf8"));
      return Array.isArray(parsed.entries) ? parsed.entries.slice(-this.limit) : [];
    } catch { return []; }
  }

  sample(replication, peer) {
    const at = new Date(this.now()).toISOString();
    const latest = this.entries.at(-1);
    const state = classify(replication, peer);
    if (latest && state.status === latest.status
      && this.now() - Date.parse(latest.at) < this.minimumIntervalMs) return latest;
    const folders = Array.isArray(replication?.folders) ? replication.folders : [];
    const entry = {
      at,
      status: state.status,
      reason: state.reason.slice(0, 180),
      peerConnected: peer?.reachable === true && peer?.identityMatched === true && replication?.peerConnected === true,
      exact: replication?.exact === true,
      needFiles: folders.reduce((sum, folder) => sum + boundedNumber(folder.needFiles, 1_000_000_000), 0),
      needBytes: folders.reduce((sum, folder) => sum + boundedNumber(folder.needBytes, 100_000_000_000), 0),
      errors: folders.reduce((sum, folder) => sum + boundedNumber(folder.errors, 1_000_000), 0),
      recoveryAgeMinutes: replication?.recovery ? boundedNumber(replication.recovery.ageMinutes, 1_000_000) : null,
    };
    this.entries.push(entry);
    this.entries = this.entries.slice(-this.limit);
    atomicWriteJson(this.path, { version: 1, entries: this.entries }, 0o600);
    const shouldAlert = latest ? latest.status !== entry.status : ["warning", "critical"].includes(entry.status);
    if (shouldAlert && entry.status !== "unconfigured") {
      const recovered = entry.status === "healthy";
      this.notificationManager?.enqueueEvent({
        eventType: "replication-health",
        eventId: at,
        dedupeKey: `replication-health:${entry.status}:${at.slice(0, 16)}`,
        severity: recovered ? "success" : entry.status === "critical" ? "failure" : "warning",
        label: recovered ? "Replication recovered" : "Replication health changed",
        status: entry.status,
        message: entry.reason,
        finishedAt: at,
        respectSeverityFilter: false,
      });
    }
    return entry;
  }

  view(limit = 96) {
    const boundedLimit = Math.max(1, Math.min(288, Number(limit) || 96));
    return { current: this.entries.at(-1) || null, entries: this.entries.slice(-boundedLimit).reverse() };
  }
}

module.exports = { ReplicationHistory, classify };
