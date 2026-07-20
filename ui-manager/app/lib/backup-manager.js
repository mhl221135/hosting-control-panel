const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFile, spawn } = require("child_process");
const { pipeline } = require("stream/promises");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

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

class BackupManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.backupsRoot = options.backupsRoot;
    this.websitesRoot = options.websitesRoot;
    this.appDataRoot = options.appDataRoot;
    this.mysqlContainer = options.mysqlContainer || "hosting-db";
    this.phpContainer = options.phpContainer || "hosting-php-fpm";
    this.siteProvider = options.siteProvider;
    this.settingsPath = path.join(this.dataDir, "backup-settings.json");
    this.busy = false;
    this.currentJob = null;
    this.lastResult = null;
    this.lastScheduleAttemptAt = 0;
    this.timer = null;
    fs.mkdirSync(this.backupsRoot, { recursive: true });
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
    fs.writeFileSync(this.settingsPath, JSON.stringify(next, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
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
    const result = await this.withLock({ type: "schedule", label: `Daily backup ${localDate}` }, async () => {
      const results = [];
      if (settings.siteBackupsEnabled) {
        const sites = await this.siteProvider();
        for (const site of sites.filter((item) => !item.isWwwAlias && item.state?.backupEnabled)) {
          try {
            results.push(await this.createSiteBackup(site, settings.retention));
          } catch (error) {
            results.push({ type: "site", domain: site.host, ok: false, message: error.message });
          }
        }
      }
      if (settings.appDataEnabled) {
        try {
          results.push(await this.createAppDataBackup(settings.retention));
        } catch (error) {
          results.push({ type: "app-data", ok: false, message: error.message });
        }
      }
      return { ok: results.every((result) => result.ok !== false), results };
    });
    if (result.ok) this.updateSettings({ lastScheduledDate: localDate });
    return result;
  }

  async runSite(site) {
    if (!this.readSettings().siteBackupsEnabled) {
      const error = new Error("Website backups are temporarily disabled in backup settings");
      error.statusCode = 409;
      throw error;
    }
    return this.withLock({ type: "site", domain: site.host, label: `Backup ${site.host}` }, () =>
      this.createSiteBackup(site, this.readSettings().retention));
  }

  async runAppData() {
    return this.withLock({ type: "app-data", label: "Backup app data" }, () =>
      this.createAppDataBackup(this.readSettings().retention));
  }

  async runSiteRestore(site, id) {
    return this.withLock({ type: "restore", domain: site.host, label: `Restore ${site.host}` }, () =>
      this.restoreSiteBackup(site, id));
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

  async createSiteBackup(site, retention) {
    const relative = this.siteRelativePath(site);
    const parent = this.safeBackupParent(site.host);
    const id = this.nextBackupId(parent);
    const partial = path.join(parent, `.partial-${id}`);
    const complete = path.join(parent, id);
    fs.mkdirSync(partial, { recursive: true });
    const startedAt = new Date().toISOString();
    try {
      const database = await this.databaseName(relative);
      await execFileAsync("ionice", [
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
        path.join(partial, "website.tar.gz"),
        "-C",
        this.websitesRoot,
        relative,
      ], { timeout: 4 * 60 * 60 * 1000, maxBuffer: 1024 * 1024 });
      await this.dumpDatabase(database, path.join(partial, "database.sql.gz"));
      const manifest = {
        version: 1,
        type: "site",
        id,
        domain: site.host,
        websitePath: relative,
        database,
        startedAt,
        completedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(partial, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      fs.renameSync(partial, complete);
      this.applyRetention(site.host, retention);
      return { ok: true, ...manifest, size: directorySize(complete) };
    } catch (error) {
      fs.rmSync(partial, { recursive: true, force: true });
      throw error;
    }
  }

  async createAppDataBackup(retention) {
    if (!fs.existsSync(this.appDataRoot)) throw new Error("App-data directory does not exist");
    const parent = this.safeBackupParent("app-data");
    const id = this.nextBackupId(parent);
    const partial = path.join(parent, `.partial-${id}`);
    const complete = path.join(parent, id);
    fs.mkdirSync(partial, { recursive: true });
    const startedAt = new Date().toISOString();
    try {
      await execFileAsync("ionice", [
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
        "-czf",
        path.join(partial, "app-data.tar.gz"),
        "--exclude=./mysql",
        "--exclude=./nginx-cache",
        "-C",
        this.appDataRoot,
        ".",
      ], { timeout: 4 * 60 * 60 * 1000, maxBuffer: 1024 * 1024 });
      await this.dumpAllDatabases(path.join(partial, "databases.sql.gz"));
      const manifest = {
        version: 1,
        type: "app-data",
        id,
        excluded: ["mysql", "nginx-cache"],
        startedAt,
        completedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(partial, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
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
    const output = fs.createWriteStream(outputPath, { mode: 0o600 });
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
      'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec nice -n 10 mysql -uroot "$1"',
      "backup-restore",
      database,
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
    for (const fileName of ["website.tar.gz", "database.sql.gz"]) {
      if (!fs.existsSync(path.join(directory, fileName))) throw new Error(`Backup is missing ${fileName}`);
    }
    return { directory, manifest };
  }

  async restoreSiteBackup(site, id) {
    const relative = this.siteRelativePath(site);
    const currentDatabase = await this.databaseName(relative);
    const { directory, manifest } = this.readSiteManifest(site, id);
    if (manifest.websitePath !== relative || manifest.database !== currentDatabase) {
      throw new Error("Backup website path or database does not match the current site");
    }

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
      await this.importDatabase(currentDatabase, path.join(directory, "database.sql.gz"));
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
        try {
          await this.importDatabase(currentDatabase, path.join(
            this.backupDirectory(site.host, safety.id),
            "database.sql.gz",
          ));
        } catch (rollbackError) {
          error.message += `; database rollback also failed: ${rollbackError.message}`;
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

  applyRetention(name, retention) {
    const entries = this.history(name);
    for (const backup of entries.slice(Number(retention))) this.deleteBackup(name, backup.id);
  }
}

function cryptoSafeSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

module.exports = { BackupManager, DEFAULT_SETTINGS, backupId };
