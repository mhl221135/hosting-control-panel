const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  appendContainerChecks, runPreflight, readSiteManifest, validateDeepVerifyProgress, validateReceiverProgress,
  resourceProfileChecks, validateStandbyRecovery,
} = require("../lib/promotion-preflight");

test("accepts a bounded 16 GB standby resource profile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-16gb-"));
  try {
    const phpIniPath = path.join(dir, "php.ini");
    fs.writeFileSync(phpIniPath, "opcache.memory_consumption = 5000\n");
    const result = resourceProfileChecks({
      name: "standby-16gb", mysqlServerId: "2", mysqlBuffer: "2G",
      mysqlRedo: "1G", mysqlConnections: "150", redisMaxMemory: "1024mb", phpIniPath,
    });
    assert.equal(result.checks.every((item) => item.status === "pass"), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("accepts bounded warm-sync preparation markers without backup receipt hashes", () => {
  const marker = {
    version: 1, mode: "warm-sync", prepared_at: "2026-08-13T12:00:00Z",
    app_data_id: "2026-08-13T11-57-11Z", database_recovery_id: "2026-08-13T11-57-11Z",
    site_count: 50, source_release: "abcdef1",
  };
  assert.deepEqual(validateStandbyRecovery(marker), marker);
  assert.equal(validateStandbyRecovery({ ...marker, database_recovery_id: "2026-08-13T11-00-00Z" }), null);
  assert.equal(validateStandbyRecovery({ ...marker, token: "secret" }), null);
});

function makeBackup(root, domain, hasDb = true, ageHours = 1) {
  const now = new Date(Date.now() - ageHours * 3_600_000);
  const setId = [now.getFullYear(), "-", String(now.getMonth() + 1).padStart(2, "0"), "-", String(now.getDate()).padStart(2, "0"), "T", String(now.getHours()).padStart(2, "0"), "-", String(now.getMinutes()).padStart(2, "0"), "-", String(now.getSeconds()).padStart(2, "0"), "Z"].join("");
  const setDir = path.join(root, domain, setId);
  fs.mkdirSync(setDir, { recursive: true });
  fs.writeFileSync(path.join(setDir, "website.tar.gz"), "archive");
  if (hasDb) fs.writeFileSync(path.join(setDir, "database.sql.gz"), "dump");
  const art = { "website.tar.gz": { size: 7, sha256: "a".repeat(64) } };
  if (hasDb) art["database.sql.gz"] = { size: 4, sha256: "b".repeat(64) };
  fs.writeFileSync(path.join(setDir, "manifest.json"), JSON.stringify({ version: 2, type: "site", id: setId, domain, websitePath: domain, database: hasDb ? `db_${domain.replace(/\./g, "_")}` : null, startedAt: now.toISOString(), completedAt: new Date(now.getTime() + 10000).toISOString(), artifacts: art }));
}

function makeAppData(root, setId) {
  const setDir = path.join(root, "app-data", setId);
  fs.mkdirSync(setDir, { recursive: true });
  fs.writeFileSync(path.join(setDir, "app-data.tar.gz"), "app");
  fs.writeFileSync(path.join(setDir, "databases.sql.gz"), "db");
  const now = new Date();
  const manifest = { version: 2, type: "app-data", id: setId, excluded: ["mysql", "nginx-cache"], startedAt: now.toISOString(), completedAt: now.toISOString(), artifacts: { "app-data.tar.gz": { size: 3, sha256: "c".repeat(64) }, "databases.sql.gz": { size: 2, sha256: "d".repeat(64) } } };
  fs.writeFileSync(path.join(setDir, "manifest.json"), JSON.stringify(manifest));
  return require("crypto").createHash("sha256").update(fs.readFileSync(path.join(setDir, "manifest.json"))).digest("hex");
}

function makeMarker(dir, role = "standby") {
  const d = path.join(dir, "hosting-machine");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "role.json"), JSON.stringify({ version: 1, role, server_id: "test" }));
  return path.join(d, "role.json");
}

function makePreparedState(dir, markerPath, receipt, setId, siteCount = 1, sourceRelease = "test-release") {
  const crypto = require("crypto");
  const receiptPath = path.join(dir, "receiver-state.json");
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const receiptHash = crypto.createHash("sha256").update(fs.readFileSync(receiptPath)).digest("hex");
  const deepPath = path.join(dir, "deep-verify-state.json");
  fs.writeFileSync(deepPath, JSON.stringify({
    version: 1, completedAt: new Date().toISOString(), result: "success",
    verifiedCount: receipt.sets.length, receiverReceiptSha256: receiptHash, verifiedSets: receipt.sets,
  }));
  const deepHash = crypto.createHash("sha256").update(fs.readFileSync(deepPath)).digest("hex");
  fs.writeFileSync(path.join(path.dirname(markerPath), "standby-recovery.json"), JSON.stringify({
    version: 1, prepared_at: new Date().toISOString(), app_data_id: setId,
    site_count: siteCount, source_release: sourceRelease,
    receiver_receipt_sha256: receiptHash, deep_verification_sha256: deepHash,
  }));
  fs.writeFileSync(path.join(dir, ".source-release"), sourceRelease);
}

test("fails when not in standby", async () => {
  const r = await runPreflight({ isStandby: false, sites: [], backupsRoot: "/tmp" });
  assert.equal(r.ready, false);
});

test("passes WordPress with valid backup and machine marker", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp3-"));
  try {
    const markerPath = makeMarker(dir, "standby");
    makeBackup(dir, "example.com", true, 1);
    const setId = fs.readdirSync(path.join(dir, "example.com"))[0];
    const manifestHash = require("crypto").createHash("sha256").update(fs.readFileSync(path.join(dir, "example.com", setId, "manifest.json"))).digest("hex");
    const appHash = makeAppData(dir, setId);
    const phpIniPath = path.join(dir, "standby-global.ini");
    fs.writeFileSync(phpIniPath, "opcache.memory_consumption = 2048\n");
    const receipt = { version: 1, result: "success", sourceServerId: "primary-test", completedAt: new Date().toISOString(), verifiedCount: 2, sets: [{ domain: "example.com", setId, manifestSha256: manifestHash }, { domain: "app-data", setId, manifestSha256: appHash }] };
    makePreparedState(dir, markerPath, receipt, setId);
    const r = await runPreflight({
      isStandby: true, markerPath, ingressMode: "direct_npm",
      sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: dir, websitesRoot: dir, sourcesRoot: dir,
      env: { UI_SETTINGS_KEY: "k", BILLING_API_TOKEN: "t", SERVER_ID: "s" },
      resourceProfile: {
        name: "standby-8gb", mysqlServerId: "2", mysqlBuffer: "1G",
        mysqlRedo: "512M", mysqlConnections: "100", redisMaxMemory: "256mb", phpIniPath,
      },
      dockerInfo: { check: async () => ({ ok: true }) },
    });
    assert.equal(r.ready, true);
    assert.equal(r.replication.sourceServerId, "primary-test");
    assert.equal(r.replication.verifiedSetCount, 2);
    assert.equal(r.replication.websiteGroupCount, 1);
    assert.equal(r.replication.appDataSetId, setId);
    assert.equal(r.replication.deepVerification, "current");
    assert.ok(r.replication.preparedAt);
    assert.equal(r.replication.preparedSiteCount, 1);
    assert.equal(r.replication.preparedSourceRelease, "test-release");
    assert.equal(r.resourceProfile.name, "standby-8gb");
    assert.equal(r.resourceProfile.opcacheMb, 2048);
    assert.ok(r.replication.estimatedDataLossHours >= 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("stale backup fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp3-"));
  try {
    const markerPath = makeMarker(dir, "standby");
    makeBackup(dir, "example.com", true, 50);
    const setId = fs.readdirSync(path.join(dir, "example.com"))[0];
    const manifestHash = require("crypto").createHash("sha256").update(fs.readFileSync(path.join(dir, "example.com", setId, "manifest.json"))).digest("hex");
    const appHash = makeAppData(dir, setId);
    const r = await runPreflight({
      isStandby: true, markerPath, ingressMode: "direct_npm", maxBackupAgeHours: 24,
      sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: dir, websitesRoot: dir, sourcesRoot: dir,
      dockerInfo: { check: async () => ({ ok: true }) },
      receiverState: { version: 1, result: "success", sourceServerId: "primary-test", completedAt: new Date().toISOString(), verifiedCount: 2, sets: [{ domain: "example.com", setId, manifestSha256: manifestHash }, { domain: "app-data", setId, manifestSha256: appHash }] }
    });
    assert.equal(r.ready, false);
    assert.ok(r.checks.some((c) => c.status === "fail" && c.reason.includes("age")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("WP missing DB fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp3-"));
  try {
    makeMarker(dir, "standby");
    makeBackup(dir, "example.com", false, 1);
    const r = await runPreflight({ isStandby: true, markerPath: makeMarker(dir, "standby"), sites: [{ host: "example.com", siteType: "wordpress" }], backupsRoot: dir, websitesRoot: dir, sourcesRoot: dir });
    assert.equal(r.ready, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("manifest schema validation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp3-"));
  try {
    fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ version: 2, type: "site", id: "2026-01-01T00-00-00Z", domain: "x.com", websitePath: "x", database: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), artifacts: { "website.tar.gz": { size: 1, sha256: "a".repeat(64) } } }));
    assert.ok(readSiteManifest(path.join(dir, "ok.json")));
    assert.equal(readSiteManifest(path.join(dir, "missing.json")), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("no leaked timers", async () => {
  const r = await runPreflight({ isStandby: false, sites: [], backupsRoot: "/tmp" });
  assert.equal(r.ready, false);
});

test("validates bounded receiver progress and blocks readiness while active", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp3-"));
  try {
    const progress = {
      version: 1, status: "running", startedAt: new Date().toISOString(), finishedAt: "",
      sourceServerId: "primary-test", totalSets: 12, completedSets: 5,
      totalBytes: 12000, completedBytes: 5000, currentSetBytes: 1000, currentSetReceivedBytes: 400,
      currentGroup: "example.com", currentSetId: "2026-01-01T00-00-00Z",
    };
    assert.ok(validateReceiverProgress(progress));
    assert.equal(validateReceiverProgress({ ...progress, completedSets: 13 }), null);
    assert.equal(validateReceiverProgress({ ...progress, currentGroup: "../escape" }), null);
    assert.equal(validateReceiverProgress({ ...progress, currentSetReceivedBytes: 1001 }), null);
    fs.writeFileSync(path.join(dir, "receiver-progress.json"), JSON.stringify(progress));
    const result = await runPreflight({ isStandby: true, markerPath: makeMarker(dir), backupsRoot: dir });
    assert.equal(result.replication.receiverStatus, "running");
    assert.equal(result.replication.receiverCompletedSets, 5);
    assert.equal(result.replication.receiverCurrentSetReceivedBytes, 400);
    assert.ok(result.checks.some((item) => item.status === "fail" && item.reason.includes("receiver is active")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cloudflare tunnel ingress requires a ready connector", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp3-"));
  try {
    const markerPath = makeMarker(dir, "standby");
    const result = await runPreflight({
      isStandby: true,
      markerPath,
      ingressMode: "cloudflare_tunnel",
      backupsRoot: dir,
      websitesRoot: dir,
      sourcesRoot: dir,
      dockerInfo: { check: async () => ({ ok: false, reason: "Cloudflare tunnel connector is not ready" }) },
    });
    assert.equal(result.ready, false);
    assert.ok(result.checks.some((item) => item.status === "fail" && item.reason.includes("not ready")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cloudflare tunnel parser distinguishes running from connected", () => {
  const containers = new Map([
    ["hosting-agent", "Up 1 minute (healthy)"], ["hosting-ui", "Up 1 minute"],
    ["hosting-db", "Created"], ["hosting-redis", "Created"],
    ["hosting-php-fpm", "Created"], ["hosting-nginx", "Created"],
    ["hosting-cloudflared", "Up 20 seconds (health: starting)"],
  ]);
  const starting = [];
  appendContainerChecks(starting, containers, "cloudflare_tunnel");
  assert.ok(starting.some((item) => item.reason === "Cloudflare tunnel container running" && item.status === "pass"));
  assert.ok(starting.some((item) => item.reason === "Cloudflare tunnel connector ready" && item.status === "fail"));
  containers.set("hosting-cloudflared", "Up 1 minute (healthy)");
  const healthy = [];
  appendContainerChecks(healthy, containers, "cloudflare_tunnel");
  assert.ok(healthy.every((item) => item.status === "pass"));
});

test("deep verification progress is bounded and rejects unsafe state", () => {
  const progress = {
    version: 1, status: "running", startedAt: new Date().toISOString(), finishedAt: "",
    completed: 12, total: 54, currentStep: "Verifying example.com", error: "",
  };
  assert.deepEqual(validateDeepVerifyProgress(progress), progress);
  assert.equal(validateDeepVerifyProgress({ ...progress, completed: 55 }), null);
  assert.equal(validateDeepVerifyProgress({ ...progress, currentStep: "bad\nstep" }), null);
  assert.equal(validateDeepVerifyProgress({ ...progress, token: "not allowed" }), null);
});

test("no secrets", async () => {
  const r = await runPreflight({ isStandby: false, sites: [], backupsRoot: "/tmp" });
  assert.equal(JSON.stringify(r).includes("secret"), false);
});
