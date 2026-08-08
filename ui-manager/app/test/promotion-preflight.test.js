const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runPreflight } = require("../lib/promotion-preflight");

function makeBackupSet(siteDir, domain, siteType = "wordpress", hasDb = true, ageHours = 1) {
  const setDir = path.join(siteDir, "2026-01-01T00-00-00");
  fs.mkdirSync(setDir, { recursive: true });
  const manifest = {
    version: 2,
    sites: [{ domain, websitePath: domain, siteType }],
    createdAt: new Date(Date.now() - ageHours * 3600_000).toISOString(),
  };
  fs.writeFileSync(path.join(setDir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(setDir, "website.tar.gz"), "archive");
  if (hasDb) fs.writeFileSync(path.join(setDir, "database.sql.gz"), "dump");
  return setDir;
}

test("fails when not in standby role", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    const backupsRoot = path.join(dir, "backups");
    fs.mkdirSync(backupsRoot, { recursive: true });
    const result = runPreflight({
      isStandby: false,
      sites: [],
      backupsRoot,
      websitesRoot: dir,
      sourcesRoot: dir,
      dataRoot: dir,
    });
    assert.equal(result.ready, false);
    assert.ok(result.checks.some((c) => c.status === "fail" && c.reason.includes("standby")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("passes with valid backup inventory and complete site manifests", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    const backups = path.join(dir, "backups");
    const sitesDir = path.join(backups, "sites");
    const siteDir = path.join(sitesDir, "example.com");
    makeBackupSet(siteDir, "example.com", "wordpress", true, 1);
    fs.mkdirSync(dir, { recursive: true }); // websites root
    fs.mkdirSync(dir, { recursive: true }); // sources root
    const result = runPreflight({
      isStandby: true,
      sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: backups,
      websitesRoot: dir,
      sourcesRoot: dir,
      dataRoot: dir,
      env: { UI_SETTINGS_KEY: "present", BILLING_API_TOKEN: "present", SERVER_ID: "test" },
    });
    assert.equal(result.ready, true);
    assert.equal(result.summary.fail, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("warns on stale backup but remains ready", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    const backups = path.join(dir, "backups");
    const sitesDir = path.join(backups, "sites");
    const siteDir = path.join(sitesDir, "example.com");
    makeBackupSet(siteDir, "example.com", "wordpress", true, 50);
    const result = runPreflight({
      isStandby: true,
      sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: backups,
      websitesRoot: dir,
      sourcesRoot: dir,
      dataRoot: dir,
      maxBackupAgeHours: 24,
    });
    assert.equal(result.ready, true);
    assert.ok(result.checks.some((c) => c.status === "warning" && c.reason.includes("age")), "stale backup should warn");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fails when a WordPress site has no database dump in its latest backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    const backups = path.join(dir, "backups");
    const sitesDir = path.join(backups, "sites");
    const siteDir = path.join(sitesDir, "example.com");
    makeBackupSet(siteDir, "example.com", "wordpress", false, 1);
    const result = runPreflight({
      isStandby: true,
      sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: backups,
      websitesRoot: dir,
      sourcesRoot: dir,
      dataRoot: dir,
    });
    assert.equal(result.ready, false);
    assert.ok(result.checks.some((c) => c.reason.includes("database dump")), "should require DB dump");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skips database check for static sites and requires archive for all", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    const backups = path.join(dir, "backups");
    const sitesDir = path.join(backups, "sites");
    const siteDir = path.join(sitesDir, "static.example");
    makeBackupSet(siteDir, "static.example", "static", false, 1);
    const result = runPreflight({
      isStandby: true,
      sites: [{ host: "static.example", siteType: "static" }],
      backupsRoot: backups,
      websitesRoot: dir,
      sourcesRoot: dir,
      dataRoot: dir,
    });
    assert.ok(result.checks.some((c) => c.reason.includes("website archive")));
    assert.equal(result.checks.some((c) => c.reason.includes("database dump")), false, "static should not check DB");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("returns bounded structured output without secrets in responses", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    const result = runPreflight({ isStandby: false, sites: [], backupsRoot: dir, websitesRoot: dir, sourcesRoot: dir, dataRoot: dir, env: { UI_SETTINGS_KEY: "secret-value-should-not-leak" } });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("secret-value-should-not-leak"), false);
    assert.equal(serialized.includes("secret"), false);
    assert.equal(typeof result.ready, "boolean");
    assert.equal(Array.isArray(result.checks), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
