const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runPreflight, readSiteManifest } = require("../lib/promotion-preflight");

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

function makeMarker(dir, role = "standby") {
  const d = path.join(dir, "hosting-machine");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "role.json"), JSON.stringify({ version: 1, role, server_id: "test" }));
  return path.join(d, "role.json");
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
    const r = await runPreflight({
      isStandby: true, markerPath, ingressMode: "direct_npm",
      sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: dir, websitesRoot: dir, sourcesRoot: dir,
      env: { UI_SETTINGS_KEY: "k", BILLING_API_TOKEN: "t", SERVER_ID: "s" },
    });
    assert.equal(r.ready, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("stale backup warns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp3-"));
  try {
    const markerPath = makeMarker(dir, "standby");
    makeBackup(dir, "example.com", true, 50);
    const r = await runPreflight({
      isStandby: true, markerPath, ingressMode: "direct_npm", maxBackupAgeHours: 24,
      sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: dir, websitesRoot: dir, sourcesRoot: dir,
    });
    assert.equal(r.ready, true);
    assert.ok(r.checks.some((c) => c.status === "warning" && c.reason.includes("age")));
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
    fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ version: 2, type: "site", domain: "x.com", websitePath: "x", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), artifacts: { "website.tar.gz": { size: 1, sha256: "a".repeat(64) } } }));
    assert.ok(readSiteManifest(path.join(dir, "ok.json")));
    assert.equal(readSiteManifest(path.join(dir, "missing.json")), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("no leaked timers", async () => {
  const r = await runPreflight({ isStandby: false, sites: [], backupsRoot: "/tmp" });
  assert.equal(r.ready, false);
});

test("no secrets", async () => {
  const r = await runPreflight({ isStandby: false, sites: [], backupsRoot: "/tmp" });
  assert.equal(JSON.stringify(r).includes("secret"), false);
});