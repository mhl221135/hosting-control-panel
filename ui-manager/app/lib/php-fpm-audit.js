const fs = require("fs");
const path = require("path");

const OPERATIONS = new Set(["save", "preview", "apply"]);
const STATUSES = new Set(["success", "failed"]);
const ROLLBACKS = new Set(["not-required", "succeeded", "failed"]);
const RESULTS = new Set(["ok", "applied", "failed"]);

const DEFAULTS = {
  maxEvents: 250,
  maxString: 160,
  maxError: 300,
  maxProfileLength: 40,
  maxFieldLength: 64,
  maxProfiles: 16,
  maxPools: 100,
  maxFields: 32,
  version: 1,
};

const SENSITIVE_PATTERNS = [
  /\bauthorization\s*:\s*[a-z0-9._-]+\s+[a-z0-9._~/+\-]{6,}/gi,
  /\bbearer\s+[a-z0-9._~/+=-]{6,}/gi,
  /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|session[_-]?id|cookie)\b\s*[:=]\s*["']?[^\s,;}"']+/gi,
  /(?:https?:\/\/)[^\s/@]*(?=@)/gi,
];

function redact(value) {
  let output = String(value);
  for (const pattern of SENSITIVE_PATTERNS) output = output.replace(pattern, "[redacted]");
  return output;
}

function slice(value, max) {
  return String(value ?? "").slice(0, max);
}

function sliceList(values, maxLength, maxEntries) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = slice(redact(value), maxLength);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    output.push(item);
    if (output.length >= maxEntries) break;
  }
  return output;
}

function normalizeOperation(value) {
  const key = String(value || "");
  return OPERATIONS.has(key) ? key : "";
}

function normalizeStatus(value) {
  const key = String(value || "success");
  return STATUSES.has(key) ? key : "success";
}

function normalizeRollback(value) {
  const key = String(value || "not-required");
  return ROLLBACKS.has(key) ? key : "not-required";
}

function normalizeResult(value) {
  const key = String(value || "ok");
  return RESULTS.has(key) ? key : "ok";
}

function atomicWrite(filePath, content, mode = 0o600) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
  fs.renameSync(temporary, filePath);
}

class PhpFpmAudit {
  constructor(options = {}) {
    this.maxEvents = Number(options.maxEvents || DEFAULTS.maxEvents);
    this.maxString = Number(options.maxString || DEFAULTS.maxString);
    this.maxError = Number(options.maxError || DEFAULTS.maxError);
    this.filePath = path.join(options.dataDir, "php-fpm-audit.json");
    this.now = options.now || (() => Date.now());
    fs.mkdirSync(options.dataDir, { recursive: true });
  }

  readHistory() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (stored && stored.version === DEFAULTS.version && Array.isArray(stored.history)) {
        return stored.history.slice(0, this.maxEvents);
      }
      return [];
    } catch {
      return [];
    }
  }

  build(input = {}) {
    const operation = normalizeOperation(input.operation);
    if (!operation) return null;
    return {
      version: DEFAULTS.version,
      at: new Date(this.now()).toISOString(),
      operator: slice(redact(input.operator), this.maxString),
      operation,
      status: normalizeStatus(input.status),
      mutating: operation !== "preview",
      profiles: sliceList(input.profiles, DEFAULTS.maxProfileLength, DEFAULTS.maxProfiles),
      selectedPools: sliceList(input.selectedPools, this.maxString, DEFAULTS.maxPools),
      affectedPools: sliceList(input.affectedPools, this.maxString, DEFAULTS.maxPools),
      changedFields: sliceList(input.changedFields, DEFAULTS.maxFieldLength, DEFAULTS.maxFields),
      rollback: normalizeRollback(input.rollback),
      result: normalizeResult(input.result),
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

  recent(limit = 100) {
    const bounded = Math.max(1, Math.min(Number(limit) || 100, this.maxEvents));
    return this.readHistory().slice(0, bounded);
  }
}

module.exports = {
  DEFAULTS,
  PhpFpmAudit,
  atomicWrite,
  normalizeOperation,
  normalizeResult,
  normalizeRollback,
  normalizeStatus,
  redact,
};
