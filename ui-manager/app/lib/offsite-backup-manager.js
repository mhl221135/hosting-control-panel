const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULTS = {
  enabled: false,
  endpoint: "",
  bucket: "",
  prefix: "hosting-control",
  region: "us-east-1",
  scheduleTime: "05:30",
  retention: 30,
  uploadLimitKib: 0,
  downloadLimitKib: 0,
  verifyPercent: 5,
  restoreTestEnabled: false,
  restoreTestDay: 0,
  restoreTestTime: "07:00",
  restoreTestMaxBytes: 2 * 1024 * 1024 * 1024,
  lastScheduledDate: "",
  lastRestoreTestWeek: "",
  lastPruneAt: "",
};

function atomicJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function validTime(value, label) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value))) {
    throw Object.assign(new Error(`${label} must use 24-hour HH:MM format`), { statusCode: 400 });
  }
  return String(value);
}

function boundedInteger(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw Object.assign(new Error(`${label} must be between ${minimum} and ${maximum}`), { statusCode: 400 });
  }
  return parsed;
}

function directorySize(target) {
  if (!fs.existsSync(target)) return 0;
  return fs.readdirSync(target, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) return total + directorySize(entryPath);
    if (entry.isFile()) return total + fs.statSync(entryPath).size;
    return total;
  }, 0);
}

function isoWeek(date) {
  const value = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  value.setUTCDate(value.getUTCDate() + 4 - (value.getUTCDay() || 7));
  const start = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value - start) / 86400000) + 1) / 7);
  return `${value.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

class OffsiteSettings {
  constructor(options) {
    this.path = path.join(options.dataDir, "offsite-backup-settings.json");
    this.encrypt = options.encrypt;
    this.decrypt = options.decrypt;
  }

  stored() {
    try {
      return JSON.parse(fs.readFileSync(this.path, "utf8"));
    } catch {
      return {};
    }
  }

  resolved() {
    const stored = this.stored();
    return {
      ...DEFAULTS,
      ...stored,
      accessKeyId: this.decrypt(stored.accessKeyId || "") || process.env.OFFSITE_ACCESS_KEY_ID || "",
      secretAccessKey: this.decrypt(stored.secretAccessKey || "") || process.env.OFFSITE_SECRET_ACCESS_KEY || "",
      repositoryPassword: this.decrypt(stored.repositoryPassword || "")
        || process.env.OFFSITE_REPOSITORY_PASSWORD || "",
    };
  }

  publicView() {
    const settings = this.resolved();
    const { accessKeyId, secretAccessKey, repositoryPassword, ...visible } = settings;
    return {
      ...visible,
      accessKeyConfigured: Boolean(accessKeyId),
      secretKeyConfigured: Boolean(secretAccessKey),
      repositoryPasswordConfigured: Boolean(repositoryPassword),
      configured: Boolean(settings.endpoint && settings.bucket && accessKeyId && secretAccessKey && repositoryPassword),
    };
  }

  update(payload, internal = false) {
    const current = this.stored();
    const next = { ...DEFAULTS, ...current };
    const assign = (key, transform = String) => {
      if (payload[key] !== undefined) next[key] = transform(payload[key]);
    };
    assign("enabled", (value) => value === true);
    assign("endpoint", (value) => String(value).trim().replace(/\/+$/, ""));
    assign("bucket", (value) => String(value).trim());
    assign("prefix", (value) => String(value).trim().replace(/^\/+|\/+$/g, ""));
    assign("region", (value) => String(value).trim());
    assign("scheduleTime", (value) => validTime(value, "Off-site schedule"));
    assign("retention", (value) => boundedInteger(value, 1, 365, "Snapshot retention"));
    assign("uploadLimitKib", (value) => boundedInteger(value, 0, 1048576, "Upload limit"));
    assign("downloadLimitKib", (value) => boundedInteger(value, 0, 1048576, "Download limit"));
    assign("verifyPercent", (value) => boundedInteger(value, 0, 100, "Verification percentage"));
    assign("restoreTestEnabled", (value) => value === true);
    assign("restoreTestDay", (value) => boundedInteger(value, 0, 6, "Restore-test weekday"));
    assign("restoreTestTime", (value) => validTime(value, "Restore-test time"));
    assign("restoreTestMaxBytes", (value) =>
      boundedInteger(value, 1048576, 1099511627776, "Restore-test maximum bytes"));
    if (internal) {
      assign("lastScheduledDate", String);
      assign("lastRestoreTestWeek", String);
      assign("lastPruneAt", String);
    }
    for (const [key, clearKey] of [
      ["accessKeyId", "clearAccessKey"],
      ["secretAccessKey", "clearSecretKey"],
      ["repositoryPassword", "clearRepositoryPassword"],
    ]) {
      if (payload[clearKey]) next[key] = "";
      else if (payload[key]) next[key] = this.encrypt(String(payload[key]));
    }
    if (next.endpoint) {
      let endpoint;
      try {
        endpoint = new URL(next.endpoint);
      } catch {
        throw Object.assign(new Error("Object-storage endpoint is not a valid URL"), { statusCode: 400 });
      }
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw Object.assign(new Error("Object-storage endpoint must be a credential-free HTTPS URL"), {
          statusCode: 400,
        });
      }
    }
    if (next.bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(next.bucket)) {
      throw Object.assign(new Error("Bucket name is invalid"), { statusCode: 400 });
    }
    if (next.prefix && (!/^[A-Za-z0-9._/-]+$/.test(next.prefix) || next.prefix.split("/").includes(".."))) {
      throw Object.assign(new Error("Repository prefix is invalid"), { statusCode: 400 });
    }
    if (next.region && !/^[A-Za-z0-9-]{1,64}$/.test(next.region)) {
      throw Object.assign(new Error("Region is invalid"), { statusCode: 400 });
    }
    const resolvedSecrets = {
      accessKeyId: this.decrypt(next.accessKeyId || "") || process.env.OFFSITE_ACCESS_KEY_ID || "",
      secretAccessKey: this.decrypt(next.secretAccessKey || "") || process.env.OFFSITE_SECRET_ACCESS_KEY || "",
      repositoryPassword: this.decrypt(next.repositoryPassword || "")
        || process.env.OFFSITE_REPOSITORY_PASSWORD || "",
    };
    if (next.enabled && (!next.endpoint || !next.bucket || Object.values(resolvedSecrets).some((value) => !value))) {
      throw Object.assign(new Error("Endpoint, bucket, access keys, and repository password are required"), {
        statusCode: 400,
      });
    }
    next.updatedAt = new Date().toISOString();
    atomicJson(this.path, next);
    return this.publicView();
  }
}

class OffsiteBackupManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.backupsRoot = options.backupsRoot;
    this.backupManager = options.backupManager;
    this.jobManager = options.jobManager;
    this.binary = options.binary || "restic";
    this.runner = options.runner || this.runProcess.bind(this);
    this.cacheDir = path.join(this.dataDir, "restic-cache");
    this.restoreRoot = path.join(this.backupsRoot, ".offsite-restore-tests");
    this.settings = new OffsiteSettings({
      dataDir: this.dataDir,
      encrypt: options.encrypt,
      decrypt: options.decrypt,
    });
    this.timer = null;
    this.lastScheduleAttemptAt = 0;
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(this.restoreRoot, { recursive: true });
    this.registerJobs();
  }

  registerJobs() {
    this.jobManager.register("offsite.initialize", (context) => this.initialize(context));
    this.jobManager.register("offsite.sync", (context) => this.sync(context));
    this.jobManager.register("offsite.check", (context) => this.check(context));
    this.jobManager.register("offsite.restore-test", (context) => this.restoreTest(context));
  }

  config() {
    const settings = this.settings.resolved();
    if (!settings.endpoint || !settings.bucket || !settings.accessKeyId
      || !settings.secretAccessKey || !settings.repositoryPassword) {
      throw Object.assign(new Error("Off-site object storage is not fully configured"), { statusCode: 409 });
    }
    const suffix = settings.prefix ? `/${settings.prefix}` : "";
    return {
      settings,
      repository: `s3:${settings.endpoint}/${settings.bucket}${suffix}`,
      env: {
        ...process.env,
        RESTIC_REPOSITORY: `s3:${settings.endpoint}/${settings.bucket}${suffix}`,
        RESTIC_PASSWORD: settings.repositoryPassword,
        AWS_ACCESS_KEY_ID: settings.accessKeyId,
        AWS_SECRET_ACCESS_KEY: settings.secretAccessKey,
        AWS_DEFAULT_REGION: settings.region,
        RESTIC_CACHE_DIR: this.cacheDir,
      },
    };
  }

  commonArgs(settings) {
    const args = [];
    if (settings.uploadLimitKib) args.push("--limit-upload", String(settings.uploadLimitKib));
    if (settings.downloadLimitKib) args.push("--limit-download", String(settings.downloadLimitKib));
    return args;
  }

  async command(args, options = {}) {
    const { settings, env } = this.config();
    return this.runner([...this.commonArgs(settings), ...args], { env, ...options });
  }

  runProcess(args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        env: options.env,
        cwd: options.cwd || this.dataDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout = (stdout + chunk.toString("utf8")).slice(-4 * 1024 * 1024);
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.message_type === "status") options.onProgress?.(event);
          } catch {
            // Some Restic commands return a JSON document instead of JSONL.
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) return resolve({ stdout, stderr });
        const message = stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 1000)
          || `Restic exited with code ${code}`;
        return reject(Object.assign(new Error(message), { code }));
      });
    });
  }

  job(type, label, operator = "system", trigger = "manual") {
    return this.jobManager.create({
      type,
      label,
      operator,
      trigger,
      payload: {},
      conflicts: ["server-heavy", "storage:backups", "offsite-repository"],
      idempotencyKey: type,
      cancellable: true,
      retryable: true,
      total: type === "offsite.sync" ? 3 : 1,
    });
  }

  async initialize(context) {
    context.update({ currentStep: "Initializing encrypted repository", total: 1 });
    await this.command(["init"]);
    context.update({ completed: 1 });
    return { ok: true, total: 1, completed: 1, message: "Encrypted off-site repository initialized" };
  }

  async sync(context) {
    return this.backupManager.withLock({ type: "offsite", label: "Off-site backup replication" }, async () => {
      const settings = this.settings.resolved();
      const syncStartedAt = Date.now();
      context.update({ total: 3, completed: 0, currentStep: "Encrypting and replicating completed backup sets" });
      await this.command([
        "backup",
        this.backupsRoot,
        "--json",
        "--skip-if-unchanged",
        "--tag", "hosting-control",
        "--host", "hosting-control",
        "--exclude", "**/.partial-*",
        "--exclude", "**/restore-test-*",
        "--exclude", "**/.offsite-restore-tests/**",
      ], {
        onProgress: (event) => context.update({
          message: `Uploaded ${Math.round(Number(event.percent_done || 0) * 100)}%`,
        }),
      });
      const snapshots = await this.snapshotRecords();
      if (!snapshots.length) throw new Error("Replication completed without a recoverable repository snapshot");
      const createdSnapshot = snapshots.some((snapshot) =>
        Number.isFinite(Date.parse(snapshot.time)) && Date.parse(snapshot.time) >= syncStartedAt - 60_000);
      context.update({ completed: 1, currentStep: "Verifying repository metadata" });
      context.checkpoint();
      await this.checkCommand(settings.verifyPercent);
      context.update({
        completed: 2,
        currentStep: createdSnapshot ? "Applying snapshot retention" : "No changed data; retaining existing snapshots",
      });
      context.checkpoint();
      if (createdSnapshot) {
        await this.command(["forget", "--tag", "hosting-control", "--keep-last", String(settings.retention), "--json"]);
        const lastPrune = Date.parse(settings.lastPruneAt || "");
        if (!Number.isFinite(lastPrune) || Date.now() - lastPrune >= 7 * 86400000) {
          await this.command(["prune"]);
          this.settings.update({ lastPruneAt: new Date().toISOString() }, true);
        }
      }
      context.update({ completed: 3 });
      return {
        ok: true,
        total: 3,
        completed: 3,
        message: createdSnapshot
          ? "Encrypted off-site replication verified"
          : "Off-site repository verified; local backup data was unchanged",
      };
    });
  }

  async checkCommand(percent) {
    const args = ["check"];
    if (percent > 0) args.push("--read-data-subset", `${percent}%`);
    return this.command(args);
  }

  async check(context) {
    const settings = this.settings.resolved();
    context.update({ currentStep: "Checking encrypted repository", total: 1 });
    await this.checkCommand(settings.verifyPercent);
    context.update({ completed: 1 });
    return { ok: true, total: 1, completed: 1, message: "Off-site repository check completed" };
  }

  restoreCandidate(maxBytes) {
    const candidates = [];
    if (!fs.existsSync(this.backupsRoot)) return null;
    for (const name of fs.readdirSync(this.backupsRoot)) {
      if (name.startsWith(".partial-")) continue;
      const parent = path.join(this.backupsRoot, name);
      if (!fs.statSync(parent).isDirectory()) continue;
      for (const id of fs.readdirSync(parent)) {
        const directory = path.join(parent, id);
        const manifest = path.join(directory, "manifest.json");
        if (!fs.existsSync(manifest) || !fs.statSync(directory).isDirectory()) continue;
        const size = directorySize(directory);
        if (size <= maxBytes) candidates.push({ directory, size });
      }
    }
    return candidates.sort((left, right) => left.size - right.size)[0] || null;
  }

  async restoreTest(context) {
    return this.backupManager.withLock({ type: "offsite-restore-test", label: "Off-site restore test" }, () =>
      this.runRestoreTest(context));
  }

  async runRestoreTest(context) {
    const settings = this.settings.resolved();
    const candidate = this.restoreCandidate(settings.restoreTestMaxBytes);
    if (!candidate) {
      throw Object.assign(new Error("No complete local backup set fits the restore-test size limit"), {
        statusCode: 409,
      });
    }
    const relative = path.relative(path.dirname(this.backupsRoot), candidate.directory).replaceAll(path.sep, "/");
    const include = `/${path.basename(path.dirname(this.backupsRoot))}/${relative}`;
    const target = path.join(this.restoreRoot, `restore-test-${Date.now()}`);
    const started = Date.now();
    fs.mkdirSync(target, { recursive: true });
    try {
      context.update({ total: 1, currentStep: "Restoring a representative encrypted backup set" });
      await this.command(["restore", "latest", "--tag", "hosting-control", "--target", target, "--include", include]);
      const restored = path.join(target, include);
      const manifest = path.join(restored, "manifest.json");
      if (!fs.existsSync(manifest)) throw new Error("Restore test did not recover the selected backup manifest");
      JSON.parse(fs.readFileSync(manifest, "utf8"));
      const size = directorySize(restored);
      if (!size) throw new Error("Restore test recovered an empty backup set");
      context.update({ completed: 1 });
      return {
        ok: true,
        total: 1,
        completed: 1,
        restoredBytes: size,
        recoverySeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
        message: "Isolated off-site restore test completed",
      };
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  async snapshotRecords() {
    const { stdout } = await this.command(["snapshots", "--tag", "hosting-control", "--json"]);
    return JSON.parse(stdout || "[]");
  }

  async snapshots() {
    const snapshots = await this.snapshotRecords();
    return snapshots.slice(-50).reverse().map((snapshot) => ({
      id: snapshot.short_id || String(snapshot.id || "").slice(0, 8),
      time: snapshot.time,
      hostname: snapshot.hostname || "",
    }));
  }

  status() {
    const settings = this.settings.publicView();
    const jobs = this.jobManager.list({ limit: 100 })
      .filter((job) => job.type.startsWith("offsite."))
      .slice(0, 10);
    return { settings, jobs };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runScheduled().catch((error) => {
      console.error(`Off-site schedule check failed: ${error.message}`);
    }), 60_000);
    this.timer.unref();
    this.runScheduled().catch((error) => console.error(`Off-site schedule check failed: ${error.message}`));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runScheduled(now = new Date()) {
    const settings = this.settings.resolved();
    if (!settings.enabled || Date.now() - this.lastScheduleAttemptAt < 15 * 60 * 1000) return null;
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (time >= settings.scheduleTime && settings.lastScheduledDate !== date) {
      this.lastScheduleAttemptAt = Date.now();
      const job = this.job("offsite.sync", `Scheduled off-site backup ${date}`, "scheduler", "scheduled");
      const finished = await this.jobManager.wait(job.id);
      if (finished.status === "succeeded") this.settings.update({ lastScheduledDate: date }, true);
      return finished;
    }
    const week = isoWeek(now);
    if (settings.restoreTestEnabled && now.getDay() === settings.restoreTestDay
      && time >= settings.restoreTestTime && settings.lastRestoreTestWeek !== week) {
      this.lastScheduleAttemptAt = Date.now();
      const job = this.job("offsite.restore-test", `Scheduled off-site restore test ${week}`, "scheduler", "scheduled");
      const finished = await this.jobManager.wait(job.id);
      if (finished.status === "succeeded") this.settings.update({ lastRestoreTestWeek: week }, true);
      return finished;
    }
    return null;
  }
}

module.exports = {
  DEFAULTS,
  OffsiteBackupManager,
  OffsiteSettings,
  directorySize,
  isoWeek,
};
