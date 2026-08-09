const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { promisify } = require("util");
const { siteAdapter, siteDatabaseReference } = require("./site-capabilities");
const { atomicWriteJson } = require("./safe-write");

const execFileAsync = promisify(execFile);
const MYSQL_RESTORE_SQL_MODE = "ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";
const NPM_BACKUP_READ_SCRIPT = "set -eu; find /etc/letsencrypt -xdev -exec chgrp -h 33 {} +; find /etc/letsencrypt -xdev -type d -exec chmod g+rX {} +; find /etc/letsencrypt -xdev -type f -exec chmod g+r {} +";

const DEFAULT_SETTINGS = {
  scheduleTime: "03:00",
  retention: 7,
  siteBackupsEnabled: true,
  appDataEnabled: true,
  lastScheduledDate: "",
};

function backupId(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
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

async function fileArtifact(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return {
    size: fs.statSync(filePath).size,
    sha256: hash.digest("hex"),
  };
}

async function artifactManifest(directory, fileNames) {
  const artifacts = {};
  for (const fileName of fileNames) artifacts[fileName] = await fileArtifact(path.join(directory, fileName));
  return artifacts;
}

async function writeHashedProcessOutput(command, args, outputPath, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const hash = crypto.createHash("sha256");
  let size = 0;
  let stderr = "";
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 64 * 1024) stderr += chunk.toString().slice(0, 64 * 1024 - stderr.length);
  });
  const timeoutMs = Math.max(1, Number(options.timeout || 4 * 60 * 60 * 1000));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    await Promise.all([
      pipeline(child.stdout, meter, fs.createWriteStream(outputPath, { mode: 0o640 }))
        .catch((error) => { child.kill("SIGKILL"); throw error; }),
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (code === 0) resolve();
          else {
            const detail = stderr.trim().replace(/[\r\n\t]+/g, " ").slice(0, 500);
            reject(new Error(`${path.basename(command)} archive failed${signal ? ` (${signal})` : ""}${detail ? `: ${detail}` : ""}`));
          }
        });
      }),
    ]);
    if (size < 1) throw new Error("Archive process produced an empty file");
    return { size, sha256: hash.digest("hex") };
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function setBackupSetPermissions(directory) {
  fs.chmodSync(directory, 0o750);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile()) fs.chmodSync(path.join(directory, entry.name), 0o640);
  }
}

async function verifyArtifactManifest(directory, manifest, requiredFiles) {
  if (manifest.version === 1 && manifest.artifacts === undefined) return { checksums: false, legacy: true };
  if (manifest.version !== 2 || !manifest.artifacts || typeof manifest.artifacts !== "object") {
    throw new Error("Backup artifact manifest is missing or unsupported");
  }
  for (const fileName of requiredFiles) {
    const expected = manifest.artifacts[fileName];
    if (!expected
      || !Number.isSafeInteger(expected.size)
      || expected.size < 1
      || !/^[a-f0-9]{64}$/.test(String(expected.sha256 || ""))) {
      throw new Error(`Backup artifact metadata is invalid: ${fileName}`);
    }
    const actual = await fileArtifact(path.join(directory, fileName));
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error(`Backup artifact checksum failed: ${fileName}`);
    }
  }
  return { checksums: true, legacy: false };
}

class BackupManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.backupsRoot = options.backupsRoot;
    this.websitesRoot = options.websitesRoot;
    this.appDataRoot = options.appDataRoot;
    this.mysqlContainer = options.mysqlContainer || "hosting-db";
    this.phpContainer = options.phpContainer || "hosting-php-fpm";
    this.siteProvider = options.siteProvider;
    this.afterRestore = options.afterRestore || null;
    this.jobManager = options.jobManager || null;
    this.settingsPath = path.join(this.dataDir, "backup-settings.json");
    this.busy = false;
    this.currentJob = null;
    this.lastResult = null;
    this.lastScheduleAttemptAt = 0;
    this.timer = null;
    fs.mkdirSync(this.backupsRoot, { recursive: true });
    if (this.jobManager) this.registerJobs();
  }

  registerJobs() {
    this.jobManager.register("backup.site", async (context, payload) => {
      const site = await this.findSite(payload.domain);
      return this.runSite(site, context);
    });
    this.jobManager.register("backup.sites", (context, payload) =>
      this.runSites(payload.scope !== "all", context));
    this.jobManager.register("backup.app-data", (context) => this.runAppData(context));
    this.jobManager.register("backup.restore", async (context, payload) => {
      const site = await this.findSite(payload.domain);
      const result = await this.runSiteRestore(site, payload.backupId, context);
      if (!payload.billingRegistration?.enabled || !this.afterRestore) return result;
      context.update({ total: 2, completed: 1, currentStep: `Registering ${site.host} with billing` });
      let billing;
      try {
        const registration = await this.afterRestore({
          site,
          registration: payload.billingRegistration,
          idempotencyKey: context.id,
        });
        billing = {
          name: "billing",
          ok: true,
          created: registration.created,
          serviceId: registration.service.serviceId,
        };
      } catch (error) {
        billing = {
          name: "billing",
          ok: false,
          message: String(error.details || error.message).slice(0, 300),
        };
      }
      result.results = [...(result.results || []), billing];
      result.total = 2;
      result.completed = 2;
      result.ok = billing.ok;
      result.message = `Restore completed for ${site.host}${billing.ok ? "" : " with a billing warning"}`;
      context.update({ total: 2, completed: 2, results: result.results });
      return result;
    });
    this.jobManager.register("backup.schedule", (context, payload) =>
      this.runScheduledWork(context, payload.scheduleDate || ""));
  }

  async findSite(domain) {
    const site = (await this.siteProvider()).find((item) => item.host === domain && !item.isWwwAlias && !item.isAlias);
    if (!site) throw Object.assign(new Error(`Site is not configured: ${domain}`), { statusCode: 404 });
    return site;
  }

  enqueueSite(site, operator = "system") {
    this.ensureSiteBackupsEnabled();
    return this.jobManager.create({
      type: "backup.site",
      label: `Backup ${site.host}`,
      operator,
      targets: [site.host],
      conflicts: ["server-heavy", `site:${site.host}`],
      idempotencyKey: `backup.site:${site.host}`,
      cancellable: false,
      payload: { domain: site.host },
      total: 1,
    });
  }

  enqueueSites(scope = "enabled", operator = "system") {
    this.ensureSiteBackupsEnabled();
    return this.jobManager.create({
      type: "backup.sites",
      label: scope === "all" ? "Backup all websites" : "Backup enabled websites",
      operator,
      conflicts: ["server-heavy", "all-sites"],
      idempotencyKey: `backup.sites:${scope}`,
      payload: { scope },
    });
  }

  enqueueAppData(operator = "system") {
    return this.jobManager.create({
      type: "backup.app-data",
      label: "Backup app data",
      operator,
      targets: ["app-data"],
      conflicts: ["server-heavy", "app-data"],
      idempotencyKey: "backup.app-data",
      cancellable: false,
      payload: {},
      total: 1,
    });
  }

  enqueueRestore(site, backupIdValue, operator = "system", billingRegistration = null) {
    return this.jobManager.create({
      type: "backup.restore",
      label: `Restore ${site.host}`,
      operator,
      targets: [site.host],
      conflicts: ["server-heavy", `site:${site.host}`],
      idempotencyKey: `backup.restore:${site.host}:${backupIdValue}`,
      cancellable: false,
      payload: {
        domain: site.host,
        backupId: String(backupIdValue),
        aliases: site.aliases || [],
        ...(billingRegistration?.enabled ? { billingRegistration } : {}),
      },
      total: billingRegistration?.enabled ? 2 : 1,
    });
  }

  readSettings() {
    let stored = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
    } catch {
      stored = {};
    }
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  updateSettings(patch) {
    const current = this.readSettings();
    const next = { ...current };
    if (patch.scheduleTime !== undefined) {
      const value = String(patch.scheduleTime);
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        const error = new Error("Backup time must use 24-hour HH:MM format");
        error.statusCode = 400;
        throw error;
      }
      next.scheduleTime = value;
    }
    if (patch.retention !== undefined) {
      const value = Number(patch.retention);
      if (!Number.isInteger(value) || value < 1 || value > 90) {
        const error = new Error("Backup retention must be between 1 and 90");
        error.statusCode = 400;
        throw error;
      }
      next.retention = value;
    }
    if (typeof patch.siteBackupsEnabled === "boolean") next.siteBackupsEnabled = patch.siteBackupsEnabled;
    if (typeof patch.appDataEnabled === "boolean") next.appDataEnabled = patch.appDataEnabled;
    if (patch.lastScheduledDate !== undefined) next.lastScheduledDate = String(patch.lastScheduledDate);
    atomicWriteJson(this.settingsPath, next, 0o600);
    return next;
  }

  status() {
    return {
      busy: this.busy,
      currentJob: this.currentJob,
      lastResult: this.lastResult,
    };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runScheduled().catch((error) => {
      console.error("Scheduled backup failed:", error.message);
    }), 30_000);
    this.timer.unref();
    this.runScheduled().catch((error) => console.error("Scheduled backup check failed:", error.message));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runScheduled(now = new Date()) {
    if (this.busy) return null;
    const settings = this.readSettings();
    const localDate = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    const localTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (localTime < settings.scheduleTime || settings.lastScheduledDate === localDate) return null;
    if (Date.now() - this.lastScheduleAttemptAt < 15 * 60 * 1000) return null;

    this.lastScheduleAttemptAt = Date.now();
    if (this.jobManager) {
      const job = this.jobManager.create({
        type: "backup.schedule",
        label: `Daily backup ${localDate}`,
        operator: "scheduler",
        trigger: "scheduled",
        conflicts: ["server-heavy", "all-sites", "app-data"],
        idempotencyKey: `backup.schedule:${localDate}`,
        payload: { scheduleDate: localDate },
      });
      const finished = await this.jobManager.wait(job.id);
      if (finished.status === "succeeded") this.updateSettings({ lastScheduledDate: localDate });
      return finished;
    }
    const result = await this.runScheduledWork();
    if (result.ok) this.updateSettings({ lastScheduledDate: localDate });
    return result;
  }

  localDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  hasCompleteBackupOnDate(name, scheduleDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(scheduleDate || ""))) return false;
    return this.history(name).some((backup) => backup.version === 2
      && backup.type === "site"
      && backup.domain === name
      && this.localDate(backup.completedAt) === scheduleDate);
  }

  async runScheduledWork(jobContext = null, scheduleDate = "") {
    const settings = this.readSettings();
    const result = await this.withLock({ type: "schedule", label: "Daily backup" }, async () => {
      const results = [];
      if (settings.siteBackupsEnabled) {
        const sites = await this.siteProvider();
        const selected = sites.filter((item) => !item.isWwwAlias && !item.isAlias && item.state?.backupEnabled);
        jobContext?.update({ total: selected.length + (settings.appDataEnabled ? 1 : 0), currentStep: "Preparing website backups" });
        for (const site of selected) {
          jobContext?.checkpoint();
          jobContext?.update({ currentStep: `Backing up ${site.host}` });
          if (scheduleDate && this.hasCompleteBackupOnDate(site.host, scheduleDate)) {
            results.push({ type: "site", domain: site.host, ok: true, skipped: true, message: "Complete daily backup already exists" });
            jobContext?.update({ completed: results.length, results });
            continue;
          }
          try {
            results.push(await this.createSiteBackup(site, settings.retention,
              (phase) => jobContext?.update({ currentStep: `${phase} ${site.host}` })));
          } catch (error) {
            results.push({ type: "site", domain: site.host, ok: false, message: error.message });
          }
          jobContext?.update({ completed: results.length, results });
        }
      }
      if (settings.appDataEnabled) {
        jobContext?.checkpoint();
        jobContext?.update({ currentStep: "Backing up application data" });
        try {
          results.push(await this.createAppDataBackup(settings.retention,
            (phase) => jobContext?.update({ currentStep: phase })));
        } catch (error) {
          results.push({ type: "app-data", ok: false, message: error.message });
        }
        jobContext?.update({ completed: results.length, results });
      }
      return {
        ok: results.every((item) => item.ok !== false),
        total: results.length,
        completed: results.length,
        results,
        message: results.every((item) => item.ok !== false)
          ? "Daily backup completed"
          : "Daily backup completed with failures",
      };
    });
    return result;
  }

  async runSite(site, jobContext = null) {
    this.ensureSiteBackupsEnabled();
    return this.withLock({ type: "site", domain: site.host, label: `Backup ${site.host}` }, async () => {
      jobContext?.update({ total: 1, currentStep: `Backing up ${site.host}` });
      const result = await this.createSiteBackup(site, this.readSettings().retention,
        (phase) => jobContext?.update({ currentStep: `${phase} ${site.host}` }));
      jobContext?.update({ completed: 1, results: [result] });
      return { ...result, total: 1, completed: 1, results: [result], message: `Backup completed for ${site.host}` };
    });
  }

  ensureSiteBackupsEnabled() {
    if (this.readSettings().siteBackupsEnabled) return;
    const error = new Error("Website backups are temporarily disabled in backup settings");
    error.statusCode = 409;
    throw error;
  }

  async runSites(onlyEnabled = true, jobContext = null) {
    this.ensureSiteBackupsEnabled();
    const label = onlyEnabled ? "Backup enabled websites" : "Backup all websites";
    return this.withLock({ type: "sites", scope: onlyEnabled ? "enabled" : "all", label }, async () => {
      const configured = (await this.siteProvider()).filter((site) => !site.isWwwAlias);
      const sites = onlyEnabled ? configured.filter((site) => site.state?.backupEnabled) : configured;
      if (!sites.length) {
        const error = new Error(onlyEnabled ? "No websites have daily backup enabled" : "No configured websites were found");
        error.statusCode = 409;
        throw error;
      }
      const results = [];
      this.currentJob.total = sites.length;
      this.currentJob.completed = 0;
      jobContext?.update({ total: sites.length, completed: 0, currentStep: "Preparing website backups" });
      for (const site of sites) {
        jobContext?.checkpoint();
        this.currentJob.domain = site.host;
        jobContext?.update({ currentStep: `Backing up ${site.host}` });
        try {
          results.push(await this.createSiteBackup(site, this.readSettings().retention,
            (phase) => jobContext?.update({ currentStep: `${phase} ${site.host}` })));
        } catch (error) {
          results.push({ type: "site", domain: site.host, ok: false, message: error.message });
        }
        this.currentJob.completed = results.length;
        jobContext?.update({ completed: results.length, results });
      }
      return {
        ok: results.every((result) => result.ok !== false),
        type: "sites",
        scope: onlyEnabled ? "enabled" : "all",
        total: sites.length,
        succeeded: results.filter((result) => result.ok !== false).length,
        failed: results.filter((result) => result.ok === false).length,
        results,
        message: results.some((result) => result.ok === false)
          ? "Website backups completed with failures"
          : "Website backups completed",
      };
    });
  }

  async runAppData(jobContext = null) {
    return this.withLock({ type: "app-data", label: "Backup app data" }, async () => {
      jobContext?.update({ total: 1, currentStep: "Backing up application data" });
      const result = await this.createAppDataBackup(this.readSettings().retention,
        (phase) => jobContext?.update({ currentStep: phase }));
      jobContext?.update({ completed: 1, results: [result] });
      return { ...result, total: 1, completed: 1, results: [result], message: "Application data backup completed" };
    });
  }

  async runSiteRestore(site, id, jobContext = null) {
    return this.withLock({ type: "restore", domain: site.host, label: `Restore ${site.host}` }, async () => {
      jobContext?.update({ total: 1, currentStep: `Restoring ${site.host}` });
      const result = await this.restoreSiteBackup(site, id);
      jobContext?.update({ completed: 1, results: [result] });
      return { ...result, total: 1, completed: 1, results: [result], message: `Restore completed for ${site.host}` };
    });
  }

  async withLock(job, work) {
    if (this.busy) {
      const error = new Error(`Another backup is already running: ${this.currentJob?.label || "backup"}`);
      error.statusCode = 409;
      throw error;
    }
    this.busy = true;
    this.currentJob = { ...job, startedAt: new Date().toISOString() };
    try {
      const result = await work();
      this.lastResult = { ...result, finishedAt: new Date().toISOString() };
      return result;
    } catch (error) {
      this.lastResult = {
        ok: false,
        type: job.type,
        domain: job.domain || "",
        message: error.message,
        finishedAt: new Date().toISOString(),
      };
      throw error;
    } finally {
      this.busy = false;
      this.currentJob = null;
    }
  }

  siteRelativePath(site) {
    const configuredRoot = String(site.root || "").replace(/\/+$/, "");
    if (!configuredRoot.startsWith("/var/www/")) throw new Error(`Unsupported document root for ${site.host}`);
    const relative = configuredRoot.slice("/var/www/".length);
    const resolved = path.resolve(this.websitesRoot, relative);
    const root = path.resolve(this.websitesRoot);
    if (!relative || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))) {
      throw new Error(`Unsafe document root for ${site.host}`);
    }
    if (!fs.existsSync(resolved)) throw new Error(`Website directory does not exist: ${relative}`);
    return relative;
  }

  async databaseName(relative) {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      "-u",
      "33:33",
      this.phpContainer,
      "wp",
      "--allow-root",
      "config",
      "get",
      "DB_NAME",
      `--path=/var/www/${relative}`,
      "--quiet",
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const name = stdout.trim();
    if (!/^[A-Za-z0-9_$-]{1,64}$/.test(name)) throw new Error("WordPress returned an invalid database name");
    return name;
  }

  async siteDatabaseName(site, relative) {
    const adapter = siteAdapter(site.state?.siteType);
    if (adapter.database === "none") return null;
    if (adapter.type !== "wordpress") {
      const reference = siteDatabaseReference(site);
      if (!reference) return null;
      if (!/^[A-Za-z0-9_$-]{1,64}$/.test(reference.name)) throw new Error(`${adapter.label} database name is invalid`);
      return reference.name;
    }
    return this.databaseName(relative);
  }

  async assertNoSiteLinks(relative) {
    const siteRoot = path.resolve(this.websitesRoot, relative);
    const { stdout } = await execFileAsync("find", [siteRoot, "-type", "l", "-print", "-quit"], {
      timeout: 5 * 60 * 1000,
      maxBuffer: 16 * 1024,
    });
    if (stdout.trim()) {
      throw new Error("Website contains symbolic links; remove or replace them before backup");
    }
  }

  async createSiteBackup(site, retention, onStep = () => {}) {
    const relative = this.siteRelativePath(site);
    await this.assertNoSiteLinks(relative);
    const parent = this.safeBackupParent(site.host);
    const id = this.nextBackupId(parent);
    const partial = path.join(parent, `.partial-${id}`);
    const complete = path.join(parent, id);
    fs.mkdirSync(partial, { recursive: true });
    const startedAt = new Date().toISOString();
    try {
      onStep("Reading database settings for");
      const database = await this.siteDatabaseName(site, relative);
      onStep("Archiving files for");
      const websiteArtifact = await writeHashedProcessOutput("ionice", [
        "-c",
        "2",
        "-n",
        "7",
        "nice",
        "-n",
        "10",
        "tar",
        "--ignore-failed-read",
        "--warning=no-file-changed",
        "--exclude=*.tmp.webp",
        "--exclude=*.tmp",
        "-czf",
        "-",
        "-C",
        this.websitesRoot,
        relative,
      ], path.join(partial, "website.tar.gz"));
      if (database) {
        onStep("Dumping database for");
        await this.dumpDatabase(database, path.join(partial, "database.sql.gz"));
      }
      onStep("Hashing backup for");
      const artifacts = { "website.tar.gz": websiteArtifact };
      if (database) artifacts["database.sql.gz"] = await fileArtifact(path.join(partial, "database.sql.gz"));
      const manifest = {
        version: 2,
        type: "site",
        id,
        domain: site.host,
        websitePath: relative,
        database,
        startedAt,
        completedAt: new Date().toISOString(),
        artifacts,
      };
      fs.writeFileSync(path.join(partial, "manifest.json"), JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o640 });
      onStep("Finalizing backup for");
      setBackupSetPermissions(partial);
      fs.renameSync(partial, complete);
      this.applyRetention(site.host, retention);
      return { ok: true, ...manifest, size: directorySize(complete) };
    } catch (error) {
      fs.rmSync(partial, { recursive: true, force: true });
      throw error;
    }
  }

  async createAppDataBackup(retention, onStep = () => {}) {
    if (!fs.existsSync(this.appDataRoot)) throw new Error("App-data directory does not exist");
    const parent = this.safeBackupParent("app-data");
    const id = this.nextBackupId(parent);
    const partial = path.join(parent, `.partial-${id}`);
    const complete = path.join(parent, id);
    fs.mkdirSync(partial, { recursive: true });
    const startedAt = new Date().toISOString();
    try {
      onStep("Preparing certificate files");
      await execFileAsync("docker", [
        "exec", "hosting-npm", "sh", "-c", NPM_BACKUP_READ_SCRIPT,
      ], { timeout: 2 * 60 * 1000, maxBuffer: 1024 * 1024 });
      onStep("Archiving application data");
      const appDataArtifact = await writeHashedProcessOutput("ionice", [
        "-c",
        "2",
        "-n",
        "7",
        "nice",
        "-n",
        "10",
        "tar",
        "--warning=no-file-changed",
        "-czf",
        "-",
        "--exclude=./mysql",
        "--exclude=./redis",
        "--exclude=./nginx-cache",
        "-C",
        this.appDataRoot,
        ".",
      ], path.join(partial, "app-data.tar.gz"));
      onStep("Dumping all databases");
      await this.dumpAllDatabases(path.join(partial, "databases.sql.gz"));
      onStep("Hashing application-data backup");
      const manifest = {
        version: 2,
        type: "app-data",
        id,
        excluded: ["mysql", "redis", "nginx-cache"],
        startedAt,
        completedAt: new Date().toISOString(),
        artifacts: {
          "app-data.tar.gz": appDataArtifact,
          "databases.sql.gz": await fileArtifact(path.join(partial, "databases.sql.gz")),
        },
      };
      fs.writeFileSync(path.join(partial, "manifest.json"), JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o640 });
      onStep("Finalizing application-data backup");
      setBackupSetPermissions(partial);
      fs.renameSync(partial, complete);
      this.applyRetention("app-data", retention);
      return { ok: true, ...manifest, size: directorySize(complete) };
    } catch (error) {
      fs.rmSync(partial, { recursive: true, force: true });
      throw error;
    }
  }

  async dumpDatabase(database, outputPath) {
    return this.dumpMysql([
      "--single-transaction",
      "--quick",
      "--routines",
      "--events",
      "--triggers",
      "--hex-blob",
      database,
    ], outputPath);
  }

  async dumpAllDatabases(outputPath) {
    return this.dumpMysql([
      "--all-databases",
      "--single-transaction",
      "--quick",
      "--routines",
      "--events",
      "--triggers",
      "--hex-blob",
    ], outputPath);
  }

  async dumpMysql(argumentsList, outputPath) {
    const process = spawn("docker", [
      "exec",
      this.mysqlContainer,
      "sh",
      "-c",
      'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec nice -n 10 mysqldump -uroot "$@"',
      "backup-mysqldump",
      ...argumentsList,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    process.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    const gzip = zlib.createGzip({ level: 6 });
    const output = fs.createWriteStream(outputPath, { mode: 0o640 });
    await Promise.all([
      pipeline(process.stdout, gzip, output),
      new Promise((resolve, reject) => {
        process.on("error", reject);
        process.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`MySQL dump failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        });
      }),
    ]);
  }

  async importDatabase(database, inputPath) {
    const process = spawn("docker", [
      "exec",
      "-i",
      this.mysqlContainer,
      "sh",
      "-c",
      'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec nice -n 10 mysql -uroot --init-command="$2" "$1"',
      "backup-restore",
      database,
      `SET SESSION sql_mode='${MYSQL_RESTORE_SQL_MODE}'`,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    process.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    await Promise.all([
      pipeline(fs.createReadStream(inputPath), zlib.createGunzip(), process.stdin),
      new Promise((resolve, reject) => {
        process.on("error", reject);
        process.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`MySQL restore failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        });
      }),
    ]);
  }

  backupDirectory(name, id) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(id)) {
      const error = new Error("Invalid backup identifier");
      error.statusCode = 400;
      throw error;
    }
    const parent = this.safeBackupParent(name);
    const target = path.resolve(parent, id);
    if (!target.startsWith(`${path.resolve(parent)}${path.sep}`) || !fs.existsSync(target)) {
      const error = new Error("Backup not found");
      error.statusCode = 404;
      throw error;
    }
    return target;
  }

  readSiteManifest(site, id) {
    const directory = this.backupDirectory(site.host, id);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
    } catch {
      throw new Error("Backup manifest is missing or invalid");
    }
    if (manifest.type !== "site" || manifest.domain !== site.host) {
      throw new Error("Backup does not belong to the selected website");
    }
    const requiredFiles = ["website.tar.gz", ...(manifest.database ? ["database.sql.gz"] : [])];
    for (const fileName of requiredFiles) {
      if (!fs.existsSync(path.join(directory, fileName))) throw new Error(`Backup is missing ${fileName}`);
    }
    return { directory, manifest };
  }

  async verifySiteBackup(site, id) {
    const relative = this.siteRelativePath(site);
    const { directory, manifest } = this.readSiteManifest(site, id);
    const archive = path.join(directory, "website.tar.gz");
    const artifactVerification = await verifyArtifactManifest(
      directory,
      manifest,
      ["website.tar.gz", ...(manifest.database ? ["database.sql.gz"] : [])],
    );
    const { stdout } = await execFileAsync("tar", ["-tzf", archive], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const entries = stdout.split("\n").filter(Boolean);
    if (!entries.length || entries.some((entry) =>
      entry.startsWith("/") || entry.split("/").includes("..")
      || (entry !== relative && !entry.startsWith(`${relative}/`)))) {
      throw new Error("Backup archive verification failed");
    }
    if (manifest.database) {
      await execFileAsync("gzip", ["-t", path.join(directory, "database.sql.gz")], {
        timeout: 10 * 60 * 1000,
        maxBuffer: 1024 * 1024,
      });
    }
    return {
      ok: true,
      id,
      domain: site.host,
      websiteEntries: entries.length,
      database: Boolean(manifest.database),
      ...artifactVerification,
    };
  }

  async restoreSiteBackup(site, id) {
    const relative = this.siteRelativePath(site);
    const currentDatabase = await this.siteDatabaseName(site, relative);
    const { directory, manifest } = this.readSiteManifest(site, id);
    if (manifest.websitePath !== relative || manifest.database !== currentDatabase) {
      throw new Error("Backup website path or database does not match the current site");
    }
    await verifyArtifactManifest(
      directory,
      manifest,
      ["website.tar.gz", ...(manifest.database ? ["database.sql.gz"] : [])],
    );

    const { stdout: archiveList } = await execFileAsync("tar", [
      "-tzf",
      path.join(directory, "website.tar.gz"),
    ], { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
    const entries = archiveList.split("\n").filter(Boolean);
    if (!entries.length || entries.some((entry) =>
      entry.startsWith("/") || entry.split("/").includes("..") ||
      (entry !== relative && !entry.startsWith(`${relative}/`)))) {
      throw new Error("Backup archive contains an unsafe website path");
    }

    const safety = await this.createSiteBackup(site, this.readSettings().retention + 1);
    const suffix = cryptoSafeSuffix();
    const staging = path.join(this.websitesRoot, `.restore-${suffix}`);
    const rollback = path.join(this.websitesRoot, `.rollback-${suffix}`);
    const current = path.resolve(this.websitesRoot, relative);
    fs.mkdirSync(staging, { recursive: true });
    let oldMoved = false;
    let swapped = false;
    try {
      await execFileAsync("tar", [
        "-xzf",
        path.join(directory, "website.tar.gz"),
        "-C",
        staging,
      ], { timeout: 4 * 60 * 60 * 1000, maxBuffer: 1024 * 1024 });
      const restored = path.resolve(staging, relative);
      if (!restored.startsWith(`${path.resolve(staging)}${path.sep}`) || !fs.existsSync(restored)) {
        throw new Error("Website directory is missing from the backup archive");
      }
      fs.renameSync(current, rollback);
      oldMoved = true;
      fs.renameSync(restored, current);
      swapped = true;
      if (currentDatabase) await this.importDatabase(currentDatabase, path.join(directory, "database.sql.gz"));
      fs.rmSync(rollback, { recursive: true, force: true });
      oldMoved = false;
      swapped = false;
      this.applyRetention(site.host, this.readSettings().retention);
      return {
        ok: true,
        type: "restore",
        domain: site.host,
        restoredBackup: id,
        safetyBackup: safety.id,
      };
    } catch (error) {
      if (swapped) {
        fs.rmSync(current, { recursive: true, force: true });
        fs.renameSync(rollback, current);
        oldMoved = false;
        if (currentDatabase) {
          try {
            await this.importDatabase(currentDatabase, path.join(
              this.backupDirectory(site.host, safety.id),
              "database.sql.gz",
            ));
          } catch (rollbackError) {
            error.message += `; database rollback also failed: ${rollbackError.message}`;
          }
        }
      } else if (oldMoved && fs.existsSync(rollback)) {
        fs.renameSync(rollback, current);
        oldMoved = false;
      }
      throw error;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      if (!oldMoved && fs.existsSync(rollback)) fs.rmSync(rollback, { recursive: true, force: true });
    }
  }

  safeBackupParent(name) {
    if (name !== "app-data" && !/^[a-z0-9.-]+$/.test(name)) throw new Error("Invalid backup name");
    const root = path.resolve(this.backupsRoot);
    const parent = path.resolve(root, name);
    if (!parent.startsWith(`${root}${path.sep}`)) throw new Error("Unsafe backup path");
    fs.mkdirSync(parent, { recursive: true });
    return parent;
  }

  nextBackupId(parent, now = new Date()) {
    for (let offset = 0; offset < 120; offset += 1) {
      const id = backupId(new Date(now.getTime() + offset * 1000));
      if (!fs.existsSync(path.join(parent, id)) && !fs.existsSync(path.join(parent, `.partial-${id}`))) return id;
    }
    throw new Error("Could not allocate a unique backup identifier");
  }

  history(name) {
    const parent = this.safeBackupParent(name);
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".partial-"))
      .map((entry) => {
        const directory = path.join(parent, entry.name);
        let manifest = {};
        try {
          manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
        } catch {
          manifest = { id: entry.name, type: name === "app-data" ? "app-data" : "site" };
        }
        return { ...manifest, id: entry.name, size: directorySize(directory) };
      })
      .sort((left, right) => right.id.localeCompare(left.id));
  }

  deleteBackup(name, id) {
    const target = this.backupDirectory(name, id);
    fs.rmSync(target, { recursive: true, force: true });
  }

  deleteSiteBackups(name) {
    if (name === "app-data") throw new Error("Application-data backups cannot be removed as website backups");
    const parent = this.safeBackupParent(name);
    fs.rmSync(parent, { recursive: true, force: true });
    fs.mkdirSync(parent, { recursive: true });
  }

  applyRetention(name, retention) {
    const entries = this.history(name);
    for (const backup of entries.slice(Number(retention))) this.deleteBackup(name, backup.id);
  }
}

function cryptoSafeSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

module.exports = {
  BackupManager,
  DEFAULT_SETTINGS,
  MYSQL_RESTORE_SQL_MODE,
  NPM_BACKUP_READ_SCRIPT,
  artifactManifest,
  writeHashedProcessOutput,
  backupId,
  setBackupSetPermissions,
  verifyArtifactManifest,
};
