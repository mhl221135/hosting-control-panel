const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ReplicationHistory, classify } = require("../lib/replication-history");

const healthyReplication = {
  available: true, peerConnected: true, exact: true,
  recovery: { ageMinutes: 10 },
  folders: [{ needFiles: 0, needBytes: 0, errors: 0 }],
};
const healthyPeer = { configured: true, reachable: true, identityMatched: true };

test("classifies peer, folder, and recovery lag", () => {
  assert.equal(classify(healthyReplication, healthyPeer).status, "healthy");
  assert.equal(classify({ ...healthyReplication, recovery: { ageMinutes: 121 } }, healthyPeer).status, "critical");
  assert.equal(classify(healthyReplication, { ...healthyPeer, identityMatched: false }).status, "critical");
});

test("persists bounded samples and alerts only on transitions", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "replication-history-"));
  let now = Date.parse("2026-08-22T12:00:00Z");
  const alerts = [];
  const history = new ReplicationHistory({
    dataDir, limit: 24, minimumIntervalMs: 60_000, now: () => now,
    notificationManager: { enqueueEvent: (event) => alerts.push(event) },
  });
  history.sample(healthyReplication, healthyPeer);
  now += 120_000;
  history.sample({ ...healthyReplication, peerConnected: false }, healthyPeer);
  assert.equal(history.view().entries.length, 2);
  assert.equal(history.view().current.status, "critical");
  assert.equal(alerts.length, 1);
  assert.doesNotMatch(fs.readFileSync(history.path, "utf8"), /token|password|secret/i);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
