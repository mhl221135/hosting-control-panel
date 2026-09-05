import assert from "node:assert/strict";
import cryptoModule from "node:crypto";
import test from "node:test";
import { WitnessState } from "../src/worker.js";
import { canonicalReceipt, hmacHex } from "../src/protocol.js";

globalThis.crypto ||= cryptoModule.webcrypto;

class Storage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
}

function post(path, value) {
  return new Request(`https://state${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
}

test("active lease blocks fencing and an expired lease yields one signed receipt", async () => {
  const storage = new Storage();
  const object = new WitnessState({ storage }, {
    LEASE_TTL_SECONDS: "90", RECEIPT_TTL_SECONDS: "600", SIGNING_KEY: "s".repeat(48),
  });
  const identity = { version: 1, primaryServerId: "hosting-server" };
  const leased = await object.fetch(post("/lease", identity));
  assert.equal(leased.status, 200);
  assert.equal((await leased.json()).status, "leased");

  const recovery = { ...identity, recoveryId: "2026-09-06T10-20-30Z" };
  assert.equal((await object.fetch(post("/fence", recovery))).status, 409);
  storage.values.get("state").leaseExpiresAt = "2020-01-01T00:00:00.000Z";

  const fenced = await object.fetch(post("/fence", recovery));
  assert.equal(fenced.status, 200);
  const receipt = await fenced.json();
  assert.equal(receipt.signature, await hmacHex("s".repeat(48), canonicalReceipt(receipt)));
  assert.equal((await object.fetch(post("/fence", recovery))).status, 409);
  assert.equal((await object.fetch(post("/lease", identity))).status, 409);

  assert.equal((await object.fetch(post("/reset", { ...identity, confirm: "RESET-FENCING-WITNESS" }))).status, 200);
  assert.equal((await object.fetch(post("/lease", identity))).status, 200);
});

test("primary identity cannot change through lease or fence calls", async () => {
  const storage = new Storage();
  await storage.put("state", { version: 1, primaryServerId: "hosting-server", fenced: false });
  const object = new WitnessState({ storage }, { SIGNING_KEY: "s".repeat(48) });
  const other = { version: 1, primaryServerId: "other-server" };
  assert.equal((await object.fetch(post("/lease", other))).status, 409);
  assert.equal((await object.fetch(post("/fence", { ...other, recoveryId: "2026-09-06T10-20-30Z" }))).status, 409);
});
