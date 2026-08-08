const fs = require("fs");
const path = require("path");
const { atomicWriteJson } = require("./safe-write");

const INGRESS_MODES = new Set(["direct_npm", "cloudflare_tunnel"]);

function normalizeIngressMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (!INGRESS_MODES.has(raw)) throw Object.assign(
    new Error("Ingress mode must be direct_npm or cloudflare_tunnel"),
    { statusCode: 400 },
  );
  return raw;
}

const DEFAULTS = { ingressMode: "" };

// Stores only safe panel metadata (ingress mode). The machine-local marker
// (`/run/hosting-machine/role.json`) is the sole authoritative source of the
// server role and identity. This store must never override the machine marker.
class PanelMetadataStore {
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
        ingressMode: normalizeIngressMode(stored.ingress_mode || DEFAULTS.ingressMode),
        source: "persisted",
      };
    } catch {
      return { ...DEFAULTS, source: "default" };
    }
  }

  save(patch = {}) {
    const current = this.read();
    const ingressMode = patch.ingress_mode !== undefined
      ? normalizeIngressMode(patch.ingress_mode)
      : current.ingressMode;
    const record = {
      version: 1,
      ingress_mode: ingressMode,
      updated_at: new Date().toISOString(),
    };
    atomicWriteJson(this.filePath, record, 0o600);
    return { ingressMode: record.ingress_mode, source: "persisted" };
  }

  publicView() {
    return this.read();
  }
}

module.exports = { INGRESS_MODES, PanelMetadataStore, normalizeIngressMode };