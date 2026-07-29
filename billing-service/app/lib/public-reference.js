const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REFERENCE = /^r1_[A-Za-z0-9_-]{43}$/;
const KEY_BYTES = 32;

function timingEqual(left, right) {
  const first = Buffer.from(String(left));
  const second = Buffer.from(String(right));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function decodeKey(value) {
  const key = Buffer.from(String(value || "").trim(), "base64url");
  if (key.length !== KEY_BYTES) throw new Error("Public renewal reference key is invalid");
  return key;
}

function fingerprint(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function atomicWrite(file, content) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

class PublicReference {
  constructor(dataDir) {
    this.file = path.join(dataDir, "public-reference.key");
    this.previousFile = path.join(dataDir, "public-reference.previous.json");
    this.key = this.loadKey();
  }

  loadKey() {
    if (fs.existsSync(this.file)) return decodeKey(fs.readFileSync(this.file, "utf8"));
    const key = crypto.randomBytes(KEY_BYTES);
    fs.writeFileSync(this.file, key.toString("base64url"), { mode: 0o600 });
    return key;
  }

  previous(now = new Date()) {
    if (!fs.existsSync(this.previousFile)) return null;
    const stored = JSON.parse(fs.readFileSync(this.previousFile, "utf8"));
    const expiresAt = new Date(stored.expiresAt);
    if (Number.isNaN(expiresAt.valueOf())) throw new Error("Previous public reference expiry is invalid");
    return {
      key: decodeKey(stored.key),
      expiresAt: expiresAt.toISOString(),
      active: expiresAt > now,
    };
  }

  status(now = new Date()) {
    const previous = this.previous(now);
    return {
      activeFingerprint: fingerprint(this.key),
      activeSince: fs.statSync(this.file).mtime.toISOString(),
      previous: previous ? {
        fingerprint: fingerprint(previous.key),
        expiresAt: previous.expiresAt,
        active: previous.active,
      } : null,
    };
  }

  rotate(overlapHours, now = new Date()) {
    const hours = Number(overlapHours);
    if (!Number.isInteger(hours) || hours < 24 || hours > 2160) {
      throw Object.assign(new Error("Overlap must be an integer from 24 to 2160 hours"), { statusCode: 400 });
    }
    const previous = this.previous(now);
    if (previous?.active) {
      throw Object.assign(new Error(`A previous key remains active until ${previous.expiresAt}`), { statusCode: 409 });
    }
    const oldKey = this.key;
    const oldActiveSince = fs.statSync(this.file).mtime.toISOString();
    const newKey = crypto.randomBytes(KEY_BYTES);
    const expiresAt = new Date(now.valueOf() + hours * 60 * 60 * 1000).toISOString();
    atomicWrite(this.previousFile, JSON.stringify({
      version: 1,
      key: oldKey.toString("base64url"),
      activeSince: oldActiveSince,
      rotatedAt: now.toISOString(),
      expiresAt,
    }, null, 2));
    try {
      atomicWrite(this.file, newKey.toString("base64url"));
    } catch (error) {
      fs.rmSync(this.previousFile, { force: true });
      throw error;
    }
    this.key = newKey;
    return this.status(now);
  }

  forService(serviceId, key = this.key) {
    const digest = crypto.createHmac("sha256", key)
      .update(`hosting-billing-renewal-v1\n${serviceId}`)
      .digest("base64url");
    return `r1_${digest}`;
  }

  resolve(reference, services, now = new Date()) {
    if (!REFERENCE.test(String(reference || ""))) return null;
    const previous = this.previous(now);
    const keys = previous?.active ? [this.key, previous.key] : [this.key];
    let match = null;
    for (const service of services) {
      for (const key of keys) {
        if (timingEqual(this.forService(service.service_id, key), reference)) match = service;
      }
    }
    return match;
  }
}

module.exports = { PublicReference, REFERENCE, decodeKey, fingerprint, timingEqual };
