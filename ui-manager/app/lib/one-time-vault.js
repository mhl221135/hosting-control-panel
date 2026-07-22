const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function boundedTtl(value) {
  const hours = Number(value || 24);
  return Math.min(Math.max(Number.isFinite(hours) ? hours : 24, 1), 168) * 60 * 60 * 1000;
}

class OneTimeVault {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    this.path = path.join(this.dataDir, options.filename || "provisioning-credentials.json");
    this.keyPath = path.join(this.dataDir, options.keyFilename || "provisioning-credentials.key");
    this.ttlMs = boundedTtl(options.ttlHours);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.key = this.loadKey();
    this.records = this.load();
    this.prune();
  }

  loadKey() {
    if (fs.existsSync(this.keyPath)) {
      const key = Buffer.from(fs.readFileSync(this.keyPath, "utf8").trim(), "base64");
      if (key.length !== 32) throw new Error("One-time vault key is invalid");
      return key;
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
    return key;
  }

  load() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.path, "utf8"));
      return stored && typeof stored.records === "object" ? stored.records : {};
    } catch {
      return {};
    }
  }

  persist() {
    const temporary = `${this.path}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: this.records }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, this.path);
  }

  prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, record] of Object.entries(this.records)) {
      if (!record?.expiresAt || new Date(record.expiresAt).getTime() <= now) {
        delete this.records[id];
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  put(id, owner, value) {
    if (!/^[0-9a-f-]{36}$/.test(String(id || ""))) throw new Error("Invalid one-time vault identifier");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    this.records[id] = {
      owner: String(owner || ""),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: encrypted.toString("base64"),
    };
    this.persist();
    return { expiresAt: this.records[id].expiresAt };
  }

  has(id, owner) {
    this.prune();
    const record = this.records[id];
    return Boolean(record && record.owner === String(owner || ""));
  }

  take(id, owner) {
    this.prune();
    const record = this.records[id];
    if (!record || record.owner !== String(owner || "")) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.iv, "base64"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]);
    delete this.records[id];
    this.persist();
    return JSON.parse(decrypted.toString("utf8"));
  }

  remove(id) {
    if (!this.records[id]) return false;
    delete this.records[id];
    this.persist();
    return true;
  }
}

module.exports = { OneTimeVault, boundedTtl };
