import assert from "node:assert/strict";
import cryptoModule from "node:crypto";
import test from "node:test";
import { canonicalReceipt, hmacHex, validRecoveryId, validServerId } from "../src/protocol.js";

globalThis.crypto ||= cryptoModule.webcrypto;

test("receipt canonicalization matches the host verifier", async () => {
  const receipt = {
    version: 1, status: "fenced", primaryServerId: "hosting-server",
    recoveryId: "2026-09-06T10-20-30Z", method: "service",
    fencedAt: "2026-09-06T10:21:00.000Z", expiresAt: "2026-09-06T10:31:00.000Z",
    nonce: "0123456789abcdef0123456789abcdef",
  };
  const key = "k".repeat(48);
  const expected = cryptoModule.createHmac("sha256", key).update(canonicalReceipt(receipt)).digest("hex");
  assert.equal(await hmacHex(key, canonicalReceipt(receipt)), expected);
});

test("identifiers are bounded", () => {
  assert.equal(validServerId("hosting-server"), true);
  assert.equal(validServerId("bad/server"), false);
  assert.equal(validRecoveryId("2026-09-06T10-20-30Z"), true);
  assert.equal(validRecoveryId("2026-09-06T10:20:30Z"), false);
});
