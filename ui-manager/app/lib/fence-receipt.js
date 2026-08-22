const crypto = require("crypto");

const RECOVERY_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NONCE = /^[A-Za-z0-9._~-]{16,128}$/;

function canonical(value) {
  return [value.version, value.status, value.primaryServerId, value.recoveryId, value.method,
    value.fencedAt, value.expiresAt, value.nonce].join("|");
}

function verifyWitnessReceipt(value, key, expected, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1 || value.status !== "fenced"
    || value.primaryServerId !== expected.primaryServerId
    || value.recoveryId !== expected.recoveryId
    || !SERVER_ID.test(String(value.primaryServerId || ""))
    || !RECOVERY_ID.test(String(value.recoveryId || ""))
    || !["power", "network", "service"].includes(value.method)
    || !NONCE.test(String(value.nonce || ""))) throw new Error("Witness receipt identity or fields are invalid");
  const fencedAt = Date.parse(value.fencedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(fencedAt) || !Number.isFinite(expiresAt) || fencedAt > now + 30_000
    || expiresAt <= now || expiresAt - fencedAt > 900_000) throw new Error("Witness receipt timestamps are invalid");
  const supplied = Buffer.from(String(value.signature || ""), "hex");
  const calculated = crypto.createHmac("sha256", key).update(canonical(value)).digest();
  if (supplied.length !== calculated.length || !crypto.timingSafeEqual(supplied, calculated)) {
    throw new Error("Witness receipt signature is invalid");
  }
  return {
    version: 1, status: "fenced", primaryServerId: value.primaryServerId,
    recoveryId: value.recoveryId, method: value.method,
    fencedAt: new Date(fencedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
    witnessNonce: value.nonce,
  };
}

module.exports = { canonical, verifyWitnessReceipt };
