const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { backup, DatabaseSync } = require("node:sqlite");
const { BillingDatabase, SCHEMA_VERSION } = require("./database");

const BACKUP_ID = /^billing-\d{8}T\d{6}Z(?:-\d+)?$/;

function checksum(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

class BillingBackups {
  constructor(store, root, retention = 14) {
    this.store = store;
    this.root = root;
    this.retention = Math.min(100, Math.max(1, Number(retention) || 14));
    this.active = false;
    fs.mkdirSync(root, { recursive: true });
  }

  async exclusive(operation) {
    if (this.active) throw Object.assign(new Error("A billing backup or restore is already running"), { statusCode: 409 });
    this.active = true;
    try {
      return await operation();
    } finally {
      this.active = false;
    }
  }

  id() {
    const base = `billing-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
    let candidate = base;
    let suffix = 1;
    while (fs.existsSync(path.join(this.root, candidate))) candidate = `${base}-${suffix++}`;
    return candidate;
  }

  list() {
    return fs.readdirSync(this.root, { withFileTypes: true }).filter((item) => item.isDirectory() && BACKUP_ID.test(item.name))
      .map((item) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.root, item.name, "manifest.json"), "utf8"));
        } catch {
          return null;
        }
      }).filter(Boolean).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  resolve(id) {
    if (!BACKUP_ID.test(String(id || ""))) throw Object.assign(new Error("Invalid billing backup ID"), { statusCode: 400 });
    const directory = path.resolve(this.root, id);
    if (!directory.startsWith(`${path.resolve(this.root)}${path.sep}`)) throw new Error("Backup path escaped its root");
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") throw Object.assign(new Error("Billing backup was not found"), { statusCode: 404 });
      throw error;
    }
    const database = path.join(directory, "billing.sqlite");
    if (manifest.id !== id || checksum(database) !== manifest.sha256) throw new Error("Billing backup verification failed");
    return { directory, database, manifest };
  }

  async createUnlocked(reason, actor) {
    const id = this.id();
    const partial = path.join(this.root, `.${id}.partial`);
    const directory = path.join(this.root, id);
    fs.mkdirSync(partial, { mode: 0o700 });
    try {
      const destination = path.join(partial, "billing.sqlite");
      await backup(this.store.db, destination);
      const verification = new DatabaseSync(destination, { readOnly: true });
      const integrity = verification.prepare("PRAGMA integrity_check").get().integrity_check;
      const services = Number(verification.prepare("SELECT COUNT(*) AS count FROM services").get().count);
      verification.close();
      if (String(integrity).toLowerCase() !== "ok") throw new Error("SQLite integrity check failed");
      const manifest = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        reason: String(reason || "manual").slice(0, 80),
        actor: String(actor || "").slice(0, 160),
        schemaVersion: SCHEMA_VERSION,
        services,
        size: fs.statSync(destination).size,
        sha256: checksum(destination),
      };
      fs.writeFileSync(path.join(partial, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      fs.renameSync(partial, directory);
      for (const stale of this.list().slice(this.retention)) fs.rmSync(path.join(this.root, stale.id), { recursive: true, force: true });
      return manifest;
    } catch (error) {
      fs.rmSync(partial, { recursive: true, force: true });
      throw error;
    }
  }

  async create(reason, actor) {
    return this.exclusive(() => this.createUnlocked(reason, actor));
  }

  test(id) {
    const selected = this.resolve(id);
    const testDirectory = path.join(this.root, `.restore-test-${crypto.randomUUID()}`);
    const testPath = path.join(testDirectory, "billing.sqlite");
    fs.mkdirSync(testDirectory, { mode: 0o700 });
    fs.copyFileSync(selected.database, testPath);
    try {
      const migrated = new BillingDatabase(testDirectory);
      const integrity = String(migrated.db.prepare("PRAGMA integrity_check").get().integrity_check);
      const schemaVersion = Number(migrated.db.prepare("PRAGMA user_version").get().user_version);
      const services = Number(migrated.db.prepare("SELECT COUNT(*) AS count FROM services").get().count);
      migrated.close();
      if (integrity.toLowerCase() !== "ok" || schemaVersion !== SCHEMA_VERSION) {
        throw new Error("Restored billing snapshot failed integrity or schema validation");
      }
      return { ok: true, integrity, schemaVersion, services };
    } finally {
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  }

  async restore(id, actor) {
    return this.exclusive(async () => {
      const selected = this.resolve(id);
      const safety = await this.createUnlocked("pre-restore-safety", actor);
      this.store.close();
      try {
        fs.copyFileSync(selected.database, this.store.path);
        fs.rmSync(`${this.store.path}-wal`, { force: true });
        fs.rmSync(`${this.store.path}-shm`, { force: true });
        this.store.open();
        if (!this.store.integrity()) throw new Error("Restored billing database failed integrity validation");
        this.store.auditEntry(actor, "backup.restore", id, { safetyBackup: safety.id });
        return { restored: id, safetyBackup: safety.id };
      } catch (error) {
        this.store.close();
        fs.copyFileSync(this.resolve(safety.id).database, this.store.path);
        this.store.open();
        throw error;
      }
    });
  }
}

module.exports = { BACKUP_ID, BillingBackups, checksum };
