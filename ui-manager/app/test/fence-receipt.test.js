const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { canonical, verifyWitnessReceipt } = require("../lib/fence-receipt");

test("accepts only a signed, recovery-bound, short-lived witness receipt", () => {
  const now = Date.parse("2026-08-22T12:00:00Z");
  const key = "k".repeat(48);
  const receipt = {
    version: 1, status: "fenced", primaryServerId: "primary-1",
    recoveryId: "2026-08-22T11-55-00Z", method: "power",
    fencedAt: "2026-08-22T11:59:50Z", expiresAt: "2026-08-22T12:09:50Z",
    nonce: "bounded-witness-nonce-1",
  };
  receipt.signature = crypto.createHmac("sha256", key).update(canonical(receipt)).digest("hex");
  assert.equal(verifyWitnessReceipt(receipt, key, {
    primaryServerId: "primary-1", recoveryId: "2026-08-22T11-55-00Z",
  }, now).status, "fenced");
  assert.throws(() => verifyWitnessReceipt({ ...receipt, recoveryId: "2026-08-22T11-56-00Z" }, key, {
    primaryServerId: "primary-1", recoveryId: "2026-08-22T11-55-00Z",
  }, now), /identity/);
  assert.throws(() => verifyWitnessReceipt({ ...receipt, signature: "00".repeat(32) }, key, {
    primaryServerId: "primary-1", recoveryId: "2026-08-22T11-55-00Z",
  }, now), /signature/);
});
