const fs = require("fs");

const ROLES = new Set(["standalone", "primary", "standby"]);
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function normalizeRole(value) {
  const role = String(value || "standalone").trim().toLowerCase();
  if (!ROLES.has(role)) throw new Error("Installation role must be standalone, primary, or standby");
  return role;
}

function normalizeServerId(value) {
  const serverId = String(value || "hosting-server").trim();
  if (!SERVER_ID.test(serverId)) throw new Error("Server identity is invalid");
  return serverId;
}

class InstallationRole {
  constructor(options = {}) {
    this.markerPath = options.markerPath || "/run/hosting-machine/role.json";
    this.fallback = {
      role: normalizeRole(options.role || process.env.INSTALLATION_ROLE),
      serverId: normalizeServerId(options.serverId || process.env.SERVER_ID),
    };
    this.state = this.read();
  }

  read() {
    if (!fs.existsSync(this.markerPath)) return { ...this.fallback, source: "environment" };
    const parsed = JSON.parse(fs.readFileSync(this.markerPath, "utf8"));
    if (!parsed || parsed.version !== 1) throw new Error("Installation role marker version is unsupported");
    return {
      role: normalizeRole(parsed.role),
      serverId: normalizeServerId(parsed.server_id),
      source: "machine-marker",
    };
  }

  isStandby() {
    return this.state.role === "standby";
  }

  publicView() {
    return { ...this.state, mutable: !this.isStandby() };
  }

  requireMutable() {
    if (this.isStandby()) {
      throw Object.assign(new Error("This server is a standby. Mutating operations are disabled until controlled promotion."), {
        statusCode: 423,
      });
    }
  }
}

module.exports = { InstallationRole, normalizeRole, normalizeServerId };
