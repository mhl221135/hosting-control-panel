const MIN_PORT = 1;
const MAX_PORT = 65535;
const MAX_HOST_LENGTH = 253;
const MAX_NAME_LENGTH = 200;
const MAX_ROOT_LENGTH = 500;
const MAX_BODY_ELEMENTS = 10000;
const MAX_BODY_DEPTH = 20;

function validationError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasPollutionKey(value) {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const key of Object.keys(current)) {
      if (POLLUTION_KEYS.has(key)) return true;
      if (current[key] && typeof current[key] === "object") stack.push(current[key]);
    }
  }
  return false;
}

// Guards against prototype-pollution and overly deep/large structures. Returns
// the original object when safe; throws a bounded error otherwise.
function guardBody(body, { maxKeys = MAX_BODY_ELEMENTS, maxDepth = MAX_BODY_DEPTH } = {}) {
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) throw validationError("Request body must be a JSON object", 400);
  let count = 0;
  const stack = [{ value: body, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (value === null || typeof value !== "object") continue;
    if (depth > maxDepth) throw validationError("Request structure is too deep", 400);
    count += 1;
    if (count > maxKeys) throw validationError("Request structure is too large", 400);
    for (const key of Object.keys(value)) {
      if (POLLUTION_KEYS.has(key)) throw validationError("Unsupported request key", 400);
      stack.push({ value: value[key], depth: depth + 1 });
    }
  }
  return body;
}

function rejectUnknownKeys(obj, allowed, label = "object") {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw validationError(`Unsupported field '${key}' in ${label}`, 400);
  }
  return obj;
}

function boundedSlug(value, { label, max = MAX_NAME_LENGTH, plural = "" } = {}) {
  const raw = String(value ?? "");
  const text = raw.trim();
  if (!text) throw validationError(`${label} is required`, 400);
  if (text.length > max) throw validationError(`${label} is too long`, 400);
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) throw validationError(`${label} contains unsupported characters`, 400);
  return text;
}

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validHostname(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw.length > MAX_HOST_LENGTH) throw validationError("Host must be a valid hostname", 400);
  if (raw.includes("..") || raw.startsWith(".") || raw.endsWith(".")) {
    throw validationError("Host contains a malformed label", 400);
  }
  const labels = raw.split(".");
  if (labels.length < 2 || labels.some((label) => !LABEL_PATTERN.test(label) || label.length > 63)) {
    throw validationError("Host must be a valid hostname", 400);
  }
  return raw;
}

function documentRoot(value, { label = "root" } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) throw validationError(`${label} is required`, 400);
  if (raw.length > MAX_ROOT_LENGTH) throw validationError(`${label} is too long`, 400);
  if (/[\r\n\0\\]/.test(raw) || raw.split("/").includes("..")) {
    throw validationError(`${label} contains unsafe path characters`, 400);
  }
  if (!raw.startsWith("/var/www/")) throw validationError(`${label} must be under /var/www`, 400);
  return raw;
}

function boundedInteger(value, { min, max, label, allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw validationError(`${label} must be an integer`, 400);
  }
  if (allowZero ? parsed < min : parsed < min || parsed === 0) {
    throw validationError(`${label} must be at least ${min}`, 400);
  }
  if (parsed > max) throw validationError(`${label} must be at most ${max}`, 400);
  return parsed;
}

function validPort(value, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === "" || value === undefined)) return null;
  return boundedInteger(value, { min: MIN_PORT, max: MAX_PORT, label: "port" });
}

function boundedStringsArray(value, { label, max = 200, count = 200 } = {}) {
  if (!Array.isArray(value)) throw validationError(`${label} must be an array`, 400);
  if (value.length > count) throw validationError(`${label} has too many entries`, 400);
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean).map((entry) => {
    if (entry.length > max) throw validationError(`${label} contains an over-long value`, 400);
    return entry;
  });
}

function optionalBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "boolean") throw validationError("Expected a boolean value", 400);
  return value;
}

function processManager(value) {
  const raw = String(value ?? "").trim();
  if (!["ondemand", "dynamic", "static"].includes(raw)) throw validationError("Invalid process manager", 400);
  return raw;
}

function durationSeconds(value, { label = "duration", min = 1, max = 3600 } = {}) {
  const match = String(value ?? "").trim().match(/^(\d+)s$/);
  if (!match) throw validationError(`${label} must be a duration like 30s`, 400);
  const parsed = Number(match[1]);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw validationError(`${label} must be between ${min}s and ${max}s`, 400);
  }
  return `${parsed}s`;
}

function optionalHostname(value) {
  const raw = String(value ?? "").trim();
  return raw ? validHostname(raw) : "";
}

const POOL_SETTING_KEYS = new Set([
  "tier", "user", "group", "pm", "max_children", "start_servers",
  "min_spare_servers", "max_spare_servers", "process_idle_timeout",
  "max_requests", "request_terminate_timeout", "open_basedir",
]);

function poolSettings(value) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw validationError("Pool settings must be an object", 400);
  rejectUnknownKeys(value, POOL_SETTING_KEYS, "pool settings");
  const result = { ...value };
  if (result.tier !== undefined) result.tier = boundedSlug(result.tier, { label: "tier", max: 20 }).toLowerCase();
  for (const field of ["user", "group"]) {
    if (result[field] !== undefined) result[field] = boundedSlug(result[field], { label: field, max: 64 });
  }
  if (result.pm !== undefined) result.pm = processManager(result.pm);
  for (const field of ["max_children", "start_servers", "min_spare_servers", "max_spare_servers"]) {
    if (result[field] !== undefined) result[field] = String(boundedInteger(result[field], { min: 0, max: 1000, label: field, allowZero: true }));
  }
  if (result.max_requests !== undefined) {
    result.max_requests = String(boundedInteger(result.max_requests, { min: 0, max: 1_000_000, label: "max_requests", allowZero: true }));
  }
  for (const field of ["process_idle_timeout", "request_terminate_timeout"]) {
    if (result[field] !== undefined) result[field] = durationSeconds(result[field], { label: field, min: 1, max: 86400 });
  }
  if (result.open_basedir !== undefined) {
    const raw = String(result.open_basedir).trim();
    if (raw.length > 1000 || /[\r\n\0]/.test(raw) || !raw.startsWith("/var/www/")) {
      throw validationError("open_basedir is invalid", 400);
    }
    result.open_basedir = raw;
  }
  return result;
}

module.exports = {
  MAX_PORT,
  MIN_PORT,
  boundedInteger,
  boundedSlug,
  boundedStringsArray,
  documentRoot,
  durationSeconds,
  guardBody,
  hasPollutionKey,
  isPlainObject,
  optionalBoolean,
  optionalHostname,
  poolSettings,
  processManager,
  rejectUnknownKeys,
  validHostname,
  validPort,
  validationError,
};
