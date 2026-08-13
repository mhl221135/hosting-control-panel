const fs = require("fs");

const SHA256 = /^[a-f0-9]{64}$/;
const SET_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const RELEASE = /^[A-Za-z0-9._-]{1,128}$/;
const KEYS = new Set([
  "version", "status", "promoted_at", "recovery_id", "source_release",
  "receiver_receipt_sha256", "deep_verification_sha256", "previous_role",
  "database_recovery_id", "preparation_mode", "public_ingress_cutover",
]);

function validatePromotionState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !KEYS.has(key))) return null;
  if (value.version !== 1 || value.status !== "local-primary" || value.previous_role !== "standby") return null;
  if (!Number.isFinite(Date.parse(value.promoted_at)) || !SET_ID.test(String(value.recovery_id || ""))) return null;
  if (!RELEASE.test(String(value.source_release || ""))) return null;
  if (!SHA256.test(String(value.receiver_receipt_sha256 || "")) || !SHA256.test(String(value.deep_verification_sha256 || ""))) return null;
  if (value.database_recovery_id !== undefined && !SET_ID.test(String(value.database_recovery_id))) return null;
  if (!["backup", "warm-sync"].includes(value.preparation_mode || "backup")) return null;
  if (typeof value.public_ingress_cutover !== "boolean") return null;
  return {
    status: value.status,
    promotedAt: value.promoted_at,
    recoveryId: value.recovery_id,
    sourceRelease: value.source_release,
    publicIngressCutover: value.public_ingress_cutover,
  };
}

function readPromotionState(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 16_384) return null;
    return validatePromotionState(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

module.exports = { readPromotionState, validatePromotionState };
