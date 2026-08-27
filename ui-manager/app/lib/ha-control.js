const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { atomicWriteJson } = require("./safe-write");

const ACTIONS = Object.freeze({
  "replicate-now": { role: "primary", confirm: "REPLICATE-NOW" },
  "finalize-standby": { role: "standby", confirm: "FINALIZE-STANDBY" },
  "failover-check": { role: "standby", confirm: "CHECK-FAILOVER" },
  "failover-hosts-preview": { role: "standby", confirm: "PREVIEW-FAILOVER-HOSTS" },
  "accept-failover-hosts": { role: "standby", confirm: "ACCEPT-QUALIFIED-FAILOVER-HOSTS" },
  "promotion-preview": { role: "standby", confirm: "PREVIEW-PROMOTION" },
  "promote-standby": { role: "standby", confirm: "PROMOTE-STANDBY-RISK-ACCEPTED" },
  "request-witness-fence": { role: "standby", confirm: "REQUEST-WITNESS-FENCE" },
  "rebuild-preview": { role: "promoted-primary", confirm: "PREVIEW-REBUILD" },
  "rebuild-former-primary": { role: "promoted-primary", confirm: "REBUILD-FORMER-PRIMARY" },
  "failback-preview": { role: "promoted-primary", confirm: "PREVIEW-FAILBACK" },
  "complete-failback": { role: "promoted-primary", confirm: "COMPLETE-FAILBACK" },
});

function readJson(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

class HaControl {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    this.requestPath = path.join(this.dataDir, "ha-control-request.json");
    this.processingPath = path.join(this.dataDir, "ha-control-request.processing.json");
    this.resultPath = path.join(this.dataDir, "ha-control-result.json");
    this.now = options.now || (() => Date.now());
  }

  view(role, serverId, promotion = null) {
    const request = readJson(this.processingPath) || readJson(this.requestPath);
    const result = readJson(this.resultPath);
    return {
      available: true,
      pending: request ? {
        id: String(request.id || "").slice(0, 80),
        action: String(request.action || "").slice(0, 40),
        requestedAt: String(request.requestedAt || "").slice(0, 40),
      } : null,
      result: result ? {
        id: String(result.id || "").slice(0, 80),
        action: String(result.action || "").slice(0, 40),
        status: ["succeeded", "failed", "rejected"].includes(result.status) ? result.status : "failed",
        message: String(result.message || "").slice(0, 240),
        completedAt: String(result.completedAt || "").slice(0, 40),
      } : null,
      actions: Object.entries(ACTIONS)
        .filter(([, definition]) => definition.role === role
          || (definition.role === "promoted-primary" && role === "primary"
            && promotion?.status === "local-primary" && promotion.publicIngressCutover === true))
        .map(([action]) => action),
      role,
      serverId,
    };
  }

  request(input, role, serverId, operator, promotion = null) {
    const action = String(input?.action || "");
    const definition = ACTIONS[action];
    const allowed = definition && (definition.role === role
      || (definition.role === "promoted-primary" && role === "primary"
        && promotion?.status === "local-primary" && promotion.publicIngressCutover === true));
    if (!allowed) {
      throw Object.assign(new Error("HA action is not available for this server role"), { statusCode: 409 });
    }
    if (input.confirm !== definition.confirm) {
      throw Object.assign(new Error(`Type ${definition.confirm} to confirm this HA action`), { statusCode: 400 });
    }
    if (fs.existsSync(this.requestPath) || fs.existsSync(this.processingPath)) {
      throw Object.assign(new Error("Another HA control request is still pending"), { statusCode: 409 });
    }
    const request = {
      version: 1,
      id: crypto.randomUUID(),
      action,
      serverId: String(serverId).slice(0, 64),
      requestedAt: new Date(this.now()).toISOString(),
      operator: crypto.createHash("sha256").update(String(operator || "panel")).digest("hex").slice(0, 16),
    };
    atomicWriteJson(this.requestPath, request, 0o600);
    return request;
  }
}

module.exports = { ACTIONS, HaControl };
