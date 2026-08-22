const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { FOLDERS, WarmReplicationStatus, folderView, parseRecoveryManifest } = require("../lib/warm-replication-status");

test("folderView bounds and allowlists Syncthing status", () => {
  assert.deepEqual(folderView("hosting-websites", {
    state: "idle", globalFiles: 12, localFiles: 13, needFiles: -2,
    needBytes: 9, receiveOnlyTotalItems: 1, errors: 0, secret: "drop",
  }), {
    id: "hosting-websites", state: "idle", globalFiles: 12, localFiles: 13,
    needFiles: 0, needBytes: 9, receiveOnlyItems: 1, errors: 0,
  });
});

test("parseRecoveryManifest reports bounded recovery age", () => {
  assert.deepEqual(parseRecoveryManifest({
    version: 1, id: "2026-08-14T00-00-00Z", createdAt: "2026-08-14T00:00:00Z", size: 100,
    sha256: "not returned",
  }, Date.parse("2026-08-14T01:05:00Z")), {
    id: "2026-08-14T00-00-00Z", createdAt: "2026-08-14T00:00:00.000Z", ageMinutes: 65, size: 100,
  });
  assert.equal(parseRecoveryManifest({ version: 2 }, Date.now()), null);
});

test("read returns exact folder state and never exposes API data outside allowlist", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warm-replication-"));
  const point = path.join(root, "2026-08-14T00-30-00Z");
  fs.mkdirSync(point);
  fs.writeFileSync(path.join(point, "manifest.json"), JSON.stringify({
    version: 1, id: "point", createdAt: "2026-08-14T00:30:00Z", size: 5, sha256: "hidden",
  }));
  const responses = [
    { connections: { PEER: { connected: true, address: "private" } } },
    { state: "idle", globalFiles: 10, localFiles: 10, needFiles: 0, receiveOnlyTotalItems: 0, errors: 0 },
    { state: "idle", globalFiles: 2, localFiles: 2, needFiles: 0, receiveOnlyTotalItems: 0, errors: 0 },
    { state: "idle", globalFiles: 3, localFiles: 3, needFiles: 0, receiveOnlyTotalItems: 0, errors: 0 },
  ];
  let apiCall = 0;
  const status = new WarmReplicationStatus({
    expectedDeviceId: "PEER",
    now: () => Date.parse("2026-08-14T01:00:00Z"),
    recoveryRoot: root,
    execFile: async (_file, args) => {
      assert.ok(args.includes("/rest/system/connections") || args.some((arg) => String(arg).startsWith("/rest/db/status")));
      return { stdout: JSON.stringify(responses[apiCall++]) };
    },
  });
  const result = await status.read();
  assert.equal(result.available, true);
  assert.equal(result.peerConnected, true);
  assert.equal(result.peerIdentityConfigured, true);
  assert.equal(result.exact, true);
  assert.equal(result.recovery.ageMinutes, 30);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("sha256"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("read ignores connected devices that do not match the expected peer", async () => {
  const responses = [
    { connections: { OTHER: { connected: true } } },
    ...FOLDERS.map(() => ({ state: "idle", needFiles: 0, receiveOnlyTotalItems: 0, errors: 0 })),
  ];
  let apiCall = 0;
  const status = new WarmReplicationStatus({
    expectedDeviceId: "EXPECTED",
    recoveryRoot: "/does-not-exist",
    execFile: async () => ({ stdout: JSON.stringify(responses[apiCall++]) }),
  });
  const result = await status.read();
  assert.equal(result.peerIdentityConfigured, true);
  assert.equal(result.peerConnected, false);
  assert.equal(JSON.stringify(result).includes("OTHER"), false);
});

test("read fails closed with bounded error", async () => {
  const status = new WarmReplicationStatus({ execFile: async () => { throw new Error("offline"); } });
  const result = await status.read();
  assert.equal(result.available, false);
  assert.equal(result.exact, false);
  assert.equal(result.error, "offline");
});
