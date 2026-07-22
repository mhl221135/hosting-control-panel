const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "partially_succeeded", "cancelled"]);
const SENSITIVE_KEY = /(?:password|passwd|secret|token|private.?key|authorization|cookie|sql|dump)/i;

class JobCancelledError extends Error {
  constructor(message = "Job cancelled at a safe boundary") {
    super(message);
    this.name = "JobCancelledError";
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function boundedText(value, maximum = 1000) {
  return String(value || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(password|passwd|dbpass|admin_password|secret|token|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bIDENTIFIED\s+BY\s+(['"])[^'"]+\1/gi, "IDENTIFIED BY '[redacted]'")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, maximum);
}

function containsSensitiveKey(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  return Object.entries(value).some(([key, child]) => SENSITIVE_KEY.test(key) || containsSensitiveKey(child));
}

function safeResult(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return boundedText(value, 2000);
  if (Array.isArray(value)) return value.slice(0, 250).map((item) => safeResult(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    if (SENSITIVE_KEY.test(key)) continue;
    result[key] = safeResult(child, depth + 1);
  }
  return result;
}

class JobManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.historyLimit = Number(options.historyLimit || 250);
    this.path = path.join(this.dataDir, "jobs.json");
    this.handlers = new Map();
    this.running = new Map();
    this.events = new EventEmitter();
    this.started = false;
    this.processing = false;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.jobs = this.load();
    this.recoverInterrupted();
    this.persist();
  }

  load() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.path, "utf8"));
      return Array.isArray(stored.jobs) ? stored.jobs : [];
    } catch {
      return [];
    }
  }

  recoverInterrupted() {
    const now = new Date().toISOString();
    for (const job of this.jobs) {
      if (job.status === "running" || job.status === "cancelling") {
        job.status = job.status === "cancelling" ? "cancelled" : "failed";
        job.finishedAt = now;
        job.currentStep = "";
        job.message = job.status === "cancelled"
          ? "Cancellation completed when the panel restarted"
          : "Job was interrupted by a panel restart";
        job.error = job.status === "failed" ? job.message : "";
      }
    }
  }

  persist() {
    this.prune();
    const temporary = `${this.path}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, jobs: this.jobs }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, this.path);
  }

  prune() {
    if (this.jobs.length <= this.historyLimit) return;
    const active = this.jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
    const terminal = this.jobs.filter((job) => TERMINAL_STATUSES.has(job.status))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, Math.max(0, this.historyLimit - active.length));
    this.jobs = [...active, ...terminal]
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  register(type, handler) {
    if (!/^[a-z0-9][a-z0-9.-]{1,80}$/.test(type)) throw new Error(`Invalid job type: ${type}`);
    if (typeof handler !== "function") throw new Error(`Job handler for ${type} must be a function`);
    if (this.handlers.has(type)) throw new Error(`Job handler is already registered: ${type}`);
    this.handlers.set(type, handler);
    this.schedule();
  }

  start() {
    this.started = true;
    this.schedule();
  }

  create(input) {
    if (!this.handlers.has(input.type)) {
      throw Object.assign(new Error(`No handler is registered for ${input.type}`), { statusCode: 400 });
    }
    const payload = input.payload || {};
    if (containsSensitiveKey(payload)) {
      throw Object.assign(new Error("Job payload contains a forbidden sensitive field"), { statusCode: 400 });
    }
    const conflicts = [...new Set((input.conflicts || []).map(String).filter(Boolean))].sort();
    const targets = [...new Set((input.targets || []).map(String).filter(Boolean))].slice(0, 250);
    if (input.idempotencyKey) {
      const existing = this.jobs.find((job) =>
        ACTIVE_STATUSES.has(job.status) && job.idempotencyKey === String(input.idempotencyKey));
      if (existing) return this.publicJob(existing);
    }
    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      type: input.type,
      label: boundedText(input.label || input.type, 160),
      status: "queued",
      operator: boundedText(input.operator || "system", 160),
      trigger: boundedText(input.trigger || "manual", 30),
      targets,
      conflicts,
      idempotencyKey: input.idempotencyKey ? boundedText(input.idempotencyKey, 200) : "",
      cancellable: input.cancellable !== false,
      retryable: input.retryable !== false,
      retryOf: input.retryOf || "",
      attempt: Number(input.attempt || 1),
      payload: clone(payload),
      createdAt: now,
      startedAt: "",
      finishedAt: "",
      total: Number(input.total || targets.length || 0),
      completed: 0,
      currentStep: "Waiting for an available worker",
      message: "Queued",
      error: "",
      results: [],
    };
    this.jobs.push(job);
    this.persist();
    this.events.emit("changed", job.id);
    this.schedule();
    return this.publicJob(job);
  }

  get(id) {
    return this.jobs.find((job) => job.id === id) || null;
  }

  publicJob(job) {
    if (!job) return null;
    const { payload, idempotencyKey, ...visible } = clone(job);
    const blockers = job.status === "queued" ? this.blockers(job) : [];
    return { ...visible, waitingFor: blockers.map((item) => ({ id: item.id, label: item.label })) };
  }

  list(filters = {}) {
    const status = String(filters.status || "");
    const type = String(filters.type || "");
    const requestedLimit = Number(filters.limit || 100);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 250) : 100;
    return this.jobs
      .filter((job) => !status || job.status === status)
      .filter((job) => !type || job.type === type)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, limit)
      .map((job) => this.publicJob(job));
  }

  blockers(job) {
    if (!job.conflicts.length) return [];
    return [...this.running.values()].filter((active) =>
      active.id !== job.id && active.conflicts.some((key) => job.conflicts.includes(key)));
  }

  schedule() {
    if (!this.started || this.processing) return;
    this.processing = true;
    queueMicrotask(() => {
      try {
        let launched = false;
        do {
          launched = false;
          for (const job of this.jobs.filter((item) => item.status === "queued")) {
            if (!this.handlers.has(job.type) || this.blockers(job).length) continue;
            this.launch(job);
            launched = true;
          }
        } while (launched);
      } finally {
        this.processing = false;
      }
    });
  }

  launch(job) {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.currentStep = "Starting";
    job.message = "Running";
    this.running.set(job.id, job);
    this.persist();
    this.events.emit("changed", job.id);
    const context = this.context(job);
    Promise.resolve()
      .then(() => this.handlers.get(job.type)(context, clone(job.payload)))
      .then((result) => this.finish(job, result || {}))
      .catch((error) => this.fail(job, error))
      .finally(() => {
        this.running.delete(job.id);
        this.events.emit("changed", job.id);
        this.schedule();
      });
  }

  context(job) {
    return {
      id: job.id,
      update: (patch = {}) => {
        if (!ACTIVE_STATUSES.has(job.status)) return this.publicJob(job);
        if (patch.total !== undefined) job.total = Math.max(0, Number(patch.total) || 0);
        if (patch.completed !== undefined) job.completed = Math.max(0, Number(patch.completed) || 0);
        if (patch.currentStep !== undefined) job.currentStep = boundedText(patch.currentStep, 240);
        if (patch.message !== undefined) job.message = boundedText(patch.message, 500);
        if (patch.results !== undefined) job.results = safeResult(patch.results);
        this.persist();
        this.events.emit("changed", job.id);
        return this.publicJob(job);
      },
      cancellationRequested: () => job.status === "cancelling",
      checkpoint: (message) => {
        if (job.status === "cancelling") throw new JobCancelledError(message);
      },
    };
  }

  finish(job, result) {
    const safe = safeResult(result);
    const results = Array.isArray(safe.results) ? safe.results : [];
    const failed = results.filter((item) => item && item.ok === false).length;
    const succeeded = results.filter((item) => !item || item.ok !== false).length;
    const cancellationWasRequested = job.status === "cancelling";
    if (cancellationWasRequested && Number(safe.completed ?? job.completed) < Number(safe.total ?? job.total)) {
      job.status = "cancelled";
      job.message = "Cancelled at a safe boundary";
    } else if (safe.status && TERMINAL_STATUSES.has(safe.status)) {
      job.status = safe.status;
    } else if (safe.ok === false && succeeded > 0 && failed > 0) {
      job.status = "partially_succeeded";
    } else if (safe.ok === false || (failed > 0 && succeeded === 0)) {
      job.status = "failed";
    } else if (failed > 0) {
      job.status = "partially_succeeded";
    } else {
      job.status = "succeeded";
    }
    job.completed = safe.completed !== undefined ? Number(safe.completed) : (job.total || job.completed);
    job.total = safe.total !== undefined ? Number(safe.total) : job.total;
    job.results = results;
    job.currentStep = "";
    const message = safe.message || this.defaultMessage(job.status);
    job.message = boundedText(
      cancellationWasRequested && job.status !== "cancelled"
        ? `${message}; cancellation arrived after the final safe boundary`
        : message,
      500,
    );
    job.error = job.status === "failed" ? boundedText(safe.error || safe.message, 1000) : "";
    job.finishedAt = new Date().toISOString();
    this.persist();
  }

  fail(job, error) {
    const cancelled = error instanceof JobCancelledError || error?.name === "JobCancelledError";
    job.status = cancelled ? "cancelled" : "failed";
    job.currentStep = "";
    job.message = cancelled ? boundedText(error.message, 500) : "Job failed";
    job.error = cancelled ? "" : boundedText(error?.message || error, 1000);
    job.finishedAt = new Date().toISOString();
    this.persist();
  }

  defaultMessage(status) {
    return {
      succeeded: "Job completed",
      failed: "Job failed",
      partially_succeeded: "Job completed with failures",
      cancelled: "Job cancelled",
    }[status] || status;
  }

  cancel(id) {
    const job = this.get(id);
    if (!job) throw Object.assign(new Error("Job not found"), { statusCode: 404 });
    if (job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      job.currentStep = "";
      job.message = "Cancelled before execution";
      this.persist();
      this.events.emit("changed", job.id);
      return this.publicJob(job);
    }
    if (job.status !== "running" && job.status !== "cancelling") {
      throw Object.assign(new Error("Only queued or running jobs can be cancelled"), { statusCode: 409 });
    }
    if (!job.cancellable) {
      throw Object.assign(new Error("This operation cannot be cancelled after it starts"), { statusCode: 409 });
    }
    job.status = "cancelling";
    job.message = "Cancellation requested; waiting for a safe boundary";
    this.persist();
    this.events.emit("changed", job.id);
    return this.publicJob(job);
  }

  retry(id, operator = "system") {
    const job = this.get(id);
    if (!job) throw Object.assign(new Error("Job not found"), { statusCode: 404 });
    if (!TERMINAL_STATUSES.has(job.status)) {
      throw Object.assign(new Error("Only finished jobs can be retried"), { statusCode: 409 });
    }
    if (!job.retryable) throw Object.assign(new Error("This job cannot be retried"), { statusCode: 409 });
    return this.create({
      type: job.type,
      label: job.label,
      operator,
      trigger: "retry",
      targets: job.targets,
      conflicts: job.conflicts,
      cancellable: job.cancellable,
      retryable: job.retryable,
      retryOf: job.id,
      attempt: Number(job.attempt || 1) + 1,
      payload: job.payload,
      total: job.total,
    });
  }

  recordNotification(id, notification) {
    const job = this.get(id);
    if (!job) return null;
    job.notifications = Array.isArray(job.notifications) ? job.notifications : [];
    const safe = safeResult(notification);
    const existing = job.notifications.findIndex((item) => item.id === safe.id);
    if (existing >= 0) job.notifications[existing] = safe;
    else job.notifications.push(safe);
    job.notifications = job.notifications.slice(-10);
    this.persist();
    return this.publicJob(job);
  }

  wait(id) {
    const current = this.get(id);
    if (!current) return Promise.reject(Object.assign(new Error("Job not found"), { statusCode: 404 }));
    if (TERMINAL_STATUSES.has(current.status)) return Promise.resolve(this.publicJob(current));
    return new Promise((resolve) => {
      const changed = (changedId) => {
        if (changedId !== id) return;
        const job = this.get(id);
        if (!job || !TERMINAL_STATUSES.has(job.status)) return;
        this.events.off("changed", changed);
        resolve(this.publicJob(job));
      };
      this.events.on("changed", changed);
    });
  }
}

module.exports = {
  ACTIVE_STATUSES,
  JobCancelledError,
  JobManager,
  TERMINAL_STATUSES,
};
