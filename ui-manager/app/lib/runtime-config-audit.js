const fs = require("fs");
const path = require("path");

const CATEGORIES = new Set([
  "pool",
  "host",
  "provisioning",
  "import",
  "reclassification",
  "opcache",
  "removal",
  "preset",
]);
const ROLLBACKS = new Set(["not-required", "succeeded", "failed"]);
const RESULTS = new Set(["success", "failed"]);
const VERIFICATIONS = new Set(["not-required", "success", "failed"]);

const DEFAULTS = {
  maxEvents: 250,
  maxString: 160,
  maxError: 300,
  maxScope: 20,
  maxCountKeys: 12,
  version: 1,
};

const ALLOWED_COUNT_KEYS = new Set([
  "poolsCreated",
  "poolsChanged",
  "poolsRemoved",
  "hostsChanged",
  "hostsRemoved",
  "routesConverted",
  "routesRecovered",
  "poolsRecovered",
]);

const CREDENTIAL_PATTERNS = [
  /\bauthorization\s*:\s*[a-z0-9._-]+\s+[a-z0-9._~/+\-]{6,}/gi,
  /\bbearer\s+[a-z0-9._~/+=-]{6,}/gi,
  /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|session[_-]?id|cookie)\b\s*[:=]\s*["']?[^\s,;}"']+/gi,
  /(?:https?:\/\/)[^\s/@]*(?=@)/gi,
];

const DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;

function redact(value) {
  let output = String(value);
  for (const pattern of [...CREDENTIAL_PATTERNS, DOMAIN_PATTERN]) output = output.replace(pattern, "[redacted]");
  return output;
}

function redactCredential(value) {
  let output = String(value);
  for (const pattern of CREDENTIAL_PATTERNS) output = output.replace(pattern, "[redacted]");
  return output;
}

function slice(value, max) {
  return String(value ?? "").slice(0, max);
}

function sliceIdentifiers(values, maxLength, maxEntries) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = redact(String(value ?? "").trim()).slice(0, maxLength);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    output.push(item);
    if (output.length >= maxEntries) break;
  }
  return output;
}

function normalizeCategory(value) {
  const key = String(value || "").toLowerCase();
  return CATEGORIES.has(key) ? key : "";
}

function normalizeRollback(value) {
  const key = String(value || "not-required");
  return ROLLBACKS.has(key) ? key : "not-required";
}

function normalizeResult(value) {
  const key = String(value || "success");
  return RESULTS.has(key) ? key : "success";
}

function normalizeVerification(value) {
  const key = String(value || "not-required");
  return VERIFICATIONS.has(key) ? key : "not-required";
}

function normalizeCounts(input = {}) {
  const counts = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return counts;
  for (const key of ALLOWED_COUNT_KEYS) {
    if (key in input) {
      const value = Number(input[key]);
      if (Number.isInteger(value) && value >= 0) counts[key] = value;
    }
  }
  return counts;
}

function atomicWrite(filePath, content, mode = 0o600) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

class RuntimeConfigAudit {
  constructor(options = {}) {
    this.maxEvents = Math.max(1, Math.min(Number(options.maxEvents) || DEFAULTS.maxEvents, 10_000));
    this.maxError = Number(options.maxError || DEFAULTS.maxError);
    this.filePath = path.join(options.dataDir, "runtime-config-audit.json");
    this.now = options.now || (() => Date.now());
  }

  readHistory() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (stored && stored.version === DEFAULTS.version && Array.isArray(stored.history)) {
        return stored.history
          .slice(0, this.maxEvents)
          .map((event) => this.build(event))
          .filter(Boolean);
      }
      return [];
    } catch {
      return [];
    }
  }

  build(input = {}) {
    const category = normalizeCategory(input.category);
    if (!category) return null;
    const requestedAt = new Date(input.at ?? this.now());
    const at = Number.isFinite(requestedAt.getTime())
      ? requestedAt.toISOString()
      : new Date(this.now()).toISOString();
    return {
      version: DEFAULTS.version,
      at,
      operator: slice(redactCredential(input.operator), this.maxString),
      category,
      mutating: input.mutating === false ? false : true,
      result: normalizeResult(input.result),
      verification: normalizeVerification(input.verification),
      rollback: normalizeRollback(input.rollback),
      counts: normalizeCounts(input.counts),
      scope: sliceIdentifiers(input.scope, 60, DEFAULTS.maxScope),
      error: slice(redact(input.error), this.maxError),
    };
  }

  record(input) {
    const event = this.build(input);
    if (!event) return null;
    const history = [event, ...this.readHistory()].slice(0, this.maxEvents);
    atomicWrite(this.filePath, JSON.stringify({ version: DEFAULTS.version, history }, null, 2), 0o600);
    return event;
  }

  recent(limit = 100, category = "") {
    const bounded = Math.max(1, Math.min(Number(limit) || 100, this.maxEvents));
    const normalizedCategory = category ? normalizeCategory(category) : "";
    if (category && !normalizedCategory) return [];
    return this.readHistory()
      .filter((event) => !normalizedCategory || event.category === normalizedCategory)
      .slice(0, bounded);
  }
}

module.exports = {
  CATEGORIES,
  DEFAULTS,
  RuntimeConfigAudit,
  atomicWrite,
  normalizeCategory,
  normalizeCounts,
  normalizeResult,
  normalizeRollback,
  normalizeVerification,
  redact,
  redactCredential,
};
