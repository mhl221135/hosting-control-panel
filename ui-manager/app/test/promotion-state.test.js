const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readPromotionState, validatePromotionState } = require("../lib/promotion-state");

function validState() {
  return {
    version: 1,
    status: "local-primary",
    promoted_at: "2026-08-09T00:00:00Z",
    recovery_id: "2026-08-08T23-55-57Z",
    source_release: "abcdef1",
    receiver_receipt_sha256: "a".repeat(64),
    deep_verification_sha256: "b".repeat(64),
    previous_role: "standby",
    public_ingress_cutover: false,
  };
}

test("exposes only bounded display-safe promotion state", () => {
  assert.deepEqual(validatePromotionState(validState()), {
    status: "local-primary",
    promotedAt: "2026-08-09T00:00:00Z",
    recoveryId: "2026-08-08T23-55-57Z",
    sourceRelease: "abcdef1",
    publicIngressCutover: false,
  });
  assert.equal(validatePromotionState({ ...validState(), token: "secret" }), null);
  assert.equal(validatePromotionState({ ...validState(), recovery_id: "../escape" }), null);
});

test("fails closed on absent or malformed promotion markers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promotion-state-"));
  try {
    const file = path.join(dir, "promotion-state.json");
    assert.equal(readPromotionState(file), null);
    fs.writeFileSync(file, "not-json");
    assert.equal(readPromotionState(file), null);
    fs.writeFileSync(file, JSON.stringify(validState()));
    assert.equal(readPromotionState(file).publicIngressCutover, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts a bounded warm-sync promotion receipt", () => {
  const state = {
    ...validState(), preparation_mode: "warm-sync",
    database_recovery_id: "2026-08-09T00-00-00Z",
  };
  assert.equal(validatePromotionState(state).status, "local-primary");
  assert.equal(validatePromotionState({ ...state, preparation_mode: "unknown" }), null);
  assert.equal(validatePromotionState({ ...state, database_recovery_id: "../db" }), null);
});
