const fs = require("fs");
const path = require("path");
const { atomicWriteJson } = require("./safe-write");

const ROLES = new Set(["standalone", "primary", "standby"]);
const INGRESS_MODES = new Set(["direct_npm", "cloudflare_tunnel"]);
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function normalizeRole(value) {
  const role = String(value || "standalone").trim().toLowerCase();
  if (!ROLES.has(role)) throw Object.assign(
    new Error("Installation role must be standalone, primary, or standby"),
    { statusCode: 400 },
  );
  return role;
}

function normalizeServerId(value) {
  const serverId = String(value || "hosting-server").trim();
  if (!SERVER_ID_PATTERN.test(serverId)) throw Object.assign(
    new Error("Server name must contain only letters, numbers, dots, hyphens, or underscores"),
    { statusCode: 400 },
  );
  return serverId;
}

function normalizeIngressMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (!INGRESS_MODES.has(raw)) throw Object.assign(
    new Error("Ingress mode must be direct_npm or cloudflare_tunnel"),
    { statusCode: 400 },
  );
  return raw;
}

const DEFAULTS = {
  role: "standalone",
  serverId: "hosting-server",
  ingressMode: "",
};

class ServerRoleStore {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(options.dataDir, "server-role.json");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  read() {
    try {
      if (!fs.existsSync(this.filePath)) return { ...DEFAULTS, source: "default" };
      const stored = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!stored || stored.version !== 1) return { ...DEFAULTS, source: "default" };
      return {
        role: normalizeRole(stored.role || DEFAULTS.role),
        serverId: normalizeServerId(stored.server_id || DEFAULTS.serverId),
        ingressMode: normalizeIngressMode(stored.ingress_mode || DEFAULTS.ingressMode),
        source: "persisted",
      };
    } catch {
      return { ...DEFAULTS, source: "default" };
    }
  }

  save(patch = {}) {
    const current = this.read();
    const role = patch.role !== undefined ? normalizeRole(patch.role) : current.role;
    const serverId = patch.server_id !== undefined ? normalizeServerId(patch.server_id) : current.serverId;
    const ingressMode = patch.ingress_mode !== undefined
      ? normalizeIngressMode(patch.ingress_mode)
      : current.ingressMode;
    const record = {
      version: 1,
      role,
      server_id: serverId,
      ingress_mode: ingressMode,
      updated_at: new Date().toISOString(),
    };
    atomicWriteJson(this.filePath, record, 0o600);
    return {
      role: record.role,
      serverId: record.server_id,
      ingressMode: record.ingress_mode,
      source: "persisted",
    };
  }

  publicView() {
    const state = this.read();
    return { ...state, mutable: state.role !== "standby" };
  }

  isStandby() {
    return this.read().role === "standby";
  }
}

module.exports = {
  ROLES,
  INGRESS_MODES,
  ServerRoleStore,
  normalizeRole,
  normalizeServerId,
  normalizeIngressMode,
};