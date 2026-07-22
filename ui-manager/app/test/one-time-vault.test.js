const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { OneTimeVault } = require("../lib/one-time-vault");

test("encrypts values and reveals them only once to their owner", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "one-time-vault-"));
  const vault = new OneTimeVault({ dataDir });
  const id = "1a6bd623-9c9f-4a5e-b9c5-1169d727b5ca";
  vault.put(id, "admin@example.com", { databasePassword: "not-in-plaintext" });

  assert.equal(fs.readFileSync(path.join(dataDir, "provisioning-credentials.json"), "utf8").includes("not-in-plaintext"), false);
  assert.equal(vault.has(id, "other@example.com"), false);
  assert.deepEqual(vault.take(id, "admin@example.com"), { databasePassword: "not-in-plaintext" });
  assert.equal(vault.take(id, "admin@example.com"), null);
});

test("persists encrypted values across instances", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "one-time-vault-"));
  const id = "c8e4f10e-983d-422d-905d-4d36cbe49b72";
  new OneTimeVault({ dataDir }).put(id, "admin@example.com", { value: "credential" });
  assert.deepEqual(new OneTimeVault({ dataDir }).take(id, "admin@example.com"), { value: "credential" });
});
