const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { InstallationRole, normalizeRole, normalizeServerId } = require("../lib/installation-role");

test("defaults to a mutable standalone environment role", () => {
  const role = new InstallationRole({ markerPath: "/missing/role.json", role: "standalone", serverId: "server-a" });
  assert.deepEqual(role.publicView(), { role: "standalone", serverId: "server-a", source: "environment", mutable: true });
});

test("machine marker overrides replicated environment and locks standby mutations", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-role-"));
  const marker = path.join(directory, "role.json");
  fs.writeFileSync(marker, JSON.stringify({ version: 1, role: "standby", server_id: "replica-1" }));
  const role = new InstallationRole({ markerPath: marker, role: "primary", serverId: "primary-1" });
  assert.equal(role.publicView().role, "standby");
  assert.equal(role.publicView().source, "machine-marker");
  assert.throws(() => role.requireMutable(), (error) => error.statusCode === 423);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("rejects malformed roles and server identities", () => {
  assert.throws(() => normalizeRole("replica"), /standalone, primary, or standby/);
  assert.throws(() => normalizeServerId("bad server"), /invalid/);
});

test("rejects an unsupported machine marker version", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-role-"));
  const marker = path.join(directory, "role.json");
  fs.writeFileSync(marker, JSON.stringify({ version: 2, role: "standby", server_id: "replica-1" }));
  assert.throws(() => new InstallationRole({ markerPath: marker }), /version is unsupported/);
  fs.rmSync(directory, { recursive: true, force: true });
});
