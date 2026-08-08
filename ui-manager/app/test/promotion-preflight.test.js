const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runPreflight, readSiteManifest } = require("../lib/promotion-preflight");

function makeBackup(root, domain, siteType = "wordpress", hasDb = true, ageHours = 1) {
  const siteDir = path.join(root, domain);
  const now = new Date(Date.now() - ageHours * 3_600_000);
  const setId = [
    now.getFullYear(),
    `-${String(now.getMonth() + 1).padStart(2, "0")}`,
    `-${String(now.getDate()).padStart(2, "0")}`,
    "T",
    String(now.getHours()).padStart(2, "0"),
    `-${String(now.getMinutes()).padStart(2, "0")}`,
    `-${String(now.getSeconds()).padStart(2, "0")}`,
    "Z",
  ].join("");
  const setDir = path.join(siteDir, setId);
  fs.mkdirSync(setDir, { recursive: true });

  const archiveContent = Buffer.from("archive-body-" + domain);
  const archiveHash = crypto.createHash("sha256").update(archiveContent).digest("hex");
  fs.writeFileSync(path.join(setDir, "website.tar.gz"), archiveContent);

  const artifacts = {
    "website.tar.gz": { size: archiveContent.length, sha256: archiveHash },
  };
  if (hasDb && siteType !== "static") {
    const dbContent = Buffer.from("dump-" + domain);
    const dbHash = crypto.createHash("sha256").update(dbContent).digest("hex");
    fs.writeFileSync(path.join(setDir, "database.sql.gz"), dbContent);
    artifacts["database.sql.gz"] = { size: dbContent.length, sha256: dbHash };
  }
  const manifest = {
    version: 2,
    type: "site",
    id: setId,
    domain,
    websitePath: domain,
    database: hasDb ? `db_${domain.replace(/\./g, "_")}` : null,
    startedAt: now.toISOString(),
    completedAt: new Date(now.getTime() + 10000).toISOString(),
    artifacts,
  };
  fs.writeFileSync(path.join(setDir, "manifest.json"), JSON.stringify(manifest));
  return setId;
}

test("fails when not in standby role", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    const result = runPreflight({ isStandby: false, sites: [], backupsRoot: dir });
    assert.equal(result.ready, false);
    assert.ok(result.checks.some((c) => c.status === "fail" && c.reason.includes("standby")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("passes with WordPress site using real backup layout", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    makeBackup(dir, "example.com", "wordpress", true, 1);
    const wRoot = path.join(dir, "websites"); fs.mkdirSync(wRoot);
    const sRoot = path.join(dir, "sources"); fs.mkdirSync(sRoot);
    const result = runPreflight({
      isStandby: true,
      sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: dir,
      websitesRoot: wRoot,
      sourcesRoot: sRoot,
      env: { UI_SETTINGS_KEY: "key", BILLING_API_TOKEN: "tok", SERVER_ID: "test" },
    });
    assert.equal(result.ready, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects stale backup with warning but remains ready", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    makeBackup(dir, "example.com", "wordpress", true, 50);
    const wRoot = path.join(dir, "websites"); fs.mkdirSync(wRoot);
    const sRoot = path.join(dir, "sources"); fs.mkdirSync(sRoot);
    const result = runPreflight({
      isStandby: true,
      sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: dir,
      websitesRoot: wRoot,
      sourcesRoot: sRoot,
      maxBackupAgeHours: 24,
    });
    assert.equal(result.ready, true);
    assert.ok(result.checks.some((c) => c.status === "warning" && c.reason.includes("age")), "stale warning expected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("WordPress without a database dump in manifest fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    makeBackup(dir, "example.com", "wordpress", false, 1);
    const wRoot = path.join(dir, "websites"); fs.mkdirSync(wRoot);
    const sRoot = path.join(dir, "sources"); fs.mkdirSync(sRoot);
    const result = runPreflight({
      isStandby: true,
      sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: dir,
      websitesRoot: wRoot,
      sourcesRoot: sRoot,
    });
    assert.equal(result.ready, false);
    assert.ok(result.checks.some((c) => c.reason.includes("database dump")), "db required for WP");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("static site does not require a database dump", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    makeBackup(dir, "static.example", "static", false, 1);
    const wRoot = path.join(dir, "websites"); fs.mkdirSync(wRoot);
    const sRoot = path.join(dir, "sources"); fs.mkdirSync(sRoot);
    const result = runPreflight({
      isStandby: true,
      sites: [{ host: "static.example", siteType: "static" }],
      backupsRoot: dir,
      websitesRoot: wRoot,
      sourcesRoot: sRoot,
    });
    assert.equal(result.checks.some((c) => c.reason.includes("database dump")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("excludes app-data and staging directories from site inventory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    makeBackup(dir, "example.com", "wordpress", true, 1);
    fs.mkdirSync(path.join(dir, "app-data", "2024-01-01T00-00-00Z"), { recursive: true });
    const result = runPreflight({
      isStandby: true,
      sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: dir,
      websitesRoot: dir,
      sourcesRoot: dir,
    });
    assert.equal(result.ready, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("role authority: missing installation role is ignored by metadata store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    // panel metadata store does not carry role; the authoritative role comes from InstallationRole
    const { PanelMetadataStore } = require("../lib/panel-metadata-store");
    const store = new PanelMetadataStore({ dataDir: dir });
    assert.equal("role" in store.publicView(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readSiteManifest parses real manifest format and rejects legacy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  try {
    const valid = path.join(dir, "valid.json");
    fs.writeFileSync(valid, JSON.stringify({
      version: 2, type: "site", domain: "x.com",
      artifacts: { "website.tar.gz": { size: 100, sha256: "a".repeat(64) } },
    }));
    assert.ok(readSiteManifest(valid));
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ version: 1 }));
    assert.equal(readSiteManifest(bad), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no secrets in preflight responses", () => {
  const result = runPreflight({ isStandby: false, sites: [], backupsRoot: "/tmp" });
  const json = JSON.stringify(result);
  assert.equal(json.includes("secret"), false);
  assert.equal(json.includes("token"), false);
  assert.equal(typeof result.ready, "boolean");
});