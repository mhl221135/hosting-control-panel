const crypto = require("crypto");

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest();
}

class HaPeerAuth {
  constructor(options = {}) {
    this.token = String(options.token || "").trim();
  }

  configured() {
    return this.token.length >= 32;
  }

  authorized(header) {
    if (!this.configured()) return false;
    const match = /^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(String(header || ""));
    if (!match) return false;
    return crypto.timingSafeEqual(digest(match[1]), digest(this.token));
  }
}

module.exports = { HaPeerAuth };
