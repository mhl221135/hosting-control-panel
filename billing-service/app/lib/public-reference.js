const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REFERENCE = /^r1_[A-Za-z0-9_-]{43}$/;

function timingEqual(left, right) {
  const first = Buffer.from(String(left));
  const second = Buffer.from(String(right));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

class PublicReference {
  constructor(dataDir) {
    this.file = path.join(dataDir, "public-reference.key");
    this.key = this.loadKey();
  }

  loadKey() {
    if (fs.existsSync(this.file)) return Buffer.from(fs.readFileSync(this.file, "utf8").trim(), "base64url");
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.file, key.toString("base64url"), { mode: 0o600 });
    return key;
  }

  forService(serviceId) {
    const digest = crypto.createHmac("sha256", this.key)
      .update(`hosting-billing-renewal-v1\n${serviceId}`)
      .digest("base64url");
    return `r1_${digest}`;
  }

  resolve(reference, services) {
    if (!REFERENCE.test(String(reference || ""))) return null;
    let match = null;
    for (const service of services) {
      if (timingEqual(this.forService(service.service_id), reference)) match = service;
    }
    return match;
  }
}

module.exports = { PublicReference, REFERENCE, timingEqual };
