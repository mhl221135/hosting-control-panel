const assert = require("node:assert/strict");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runPreflight, readSiteManifest } = require("../lib/promotion-preflight");

// Creates a real tar.gz file in a temp directory
function makeTarGz(outputPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tar-"));
  const src = path.join(dir, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "index.php"), "<?php echo 'ok';");
  fs.writeFileSync(path.join(src, "wp-config.php"), "<?php return [];");
  execFileSync("tar", ["-czf", outputPath, "-C", src, "."], { stdio: "ignore" });
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeGzip(outputPath, content) {
  const zlib = require("zlib");
  fs.writeFileSync(outputPath, zlib.gzipSync(Buffer.from(content)));
}

function makeBackup(root, domain, siteType = "wordpress", hasDb = true, ageHours = 1) {
  const now = new Date(Date.now() - ageHours * 3_600_000);
  const setId = [
    now.getFullYear(), `-${String(now.getMonth() + 1).padStart(2, "0")}`,
    `-${String(now.getDate()).padStart(2, "0")}`,
    "T", String(now.getHours()).padStart(2, "0"),
    `-${String(now.getMinutes()).padStart(2, "0")}`,
    `-${String(now.getSeconds()).padStart(2, "0")}`, "Z",
  ].join("");
  const setDir = path.join(root, domain, setId);
  fs.mkdirSync(setDir, { recursive: true });
  const archivePath = path.join(setDir, "website.tar.gz");
  makeTarGz(archivePath);
  const archiveSize = fs.statSync(archivePath).size;
  const archiveHash = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
  const artifacts = { "website.tar.gz": { size: archiveSize, sha256: archiveHash } };
  if (hasDb) {
    const dbPath = path.join(setDir, "database.sql.gz");
    makeGzip(dbPath, "INSERT INTO wp_options VALUES(1,'siteurl','http://example.com','yes');");
    const dbSize = fs.statSync(dbPath).size;
    const dbHash = crypto.createHash("sha256").update(fs.readFileSync(dbPath)).digest("hex");
    artifacts["database.sql.gz"] = { size: dbSize, sha256: dbHash };
  }
  fs.writeFileSync(path.join(setDir, "manifest.json"), JSON.stringify({
    version: 2, type: "site", id: setId, domain, websitePath: domain,
    database: hasDb ? `db_${domain.replace(/\./g, "_")}` : null,
    startedAt: now.toISOString(), completedAt: new Date(now.getTime() + 10_000).toISOString(),
    artifacts,
  }));
}

test("fails when not in standby role", async () => {
  const result = await runPreflight({ isStandby: false, sites: [], backupsRoot: "/tmp" });
  assert.equal(result.ready, false);
});

test("passes WordPress with real tar.gz backup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp2-"));
  try {
    makeBackup(dir, "example.com", "wordpress", true, 1);
    const wRoot = path.join(dir, "websites"); fs.mkdirSync(wRoot);
    const sRoot = path.join(dir, "sources"); fs.mkdirSync(sRoot);
    const result = await runPreflight({
      isStandby: true, sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: dir, websitesRoot: wRoot, sourcesRoot: sRoot,
      env: { UI_SETTINGS_KEY: "k", BILLING_API_TOKEN: "t", SERVER_ID: "s" },
    });
    assert.equal(result.ready, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("rejects stale backup with warning", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp2-"));
  try {
    makeBackup(dir, "example.com", "wordpress", true, 50);
    const wRoot = path.join(dir, "websites"); fs.mkdirSync(wRoot);
    const sRoot = path.join(dir, "sources"); fs.mkdirSync(sRoot);
    const result = await runPreflight({
      isStandby: true, sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: dir, websitesRoot: wRoot, sourcesRoot: sRoot, maxBackupAgeHours: 24,
    });
    assert.equal(result.ready, true);
    assert.ok(result.checks.some((c) => c.status === "warning" && c.reason.includes("age")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("WordPress missing database dump fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp2-"));
  try {
    makeBackup(dir, "example.com", "wordpress", false, 1);
    const wRoot = path.join(dir, "websites"); fs.mkdirSync(wRoot);
    const sRoot = path.join(dir, "sources"); fs.mkdirSync(sRoot);
    const result = await runPreflight({
      isStandby: true, sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: dir, websitesRoot: wRoot, sourcesRoot: sRoot,
    });
    assert.equal(result.ready, false);
    assert.ok(result.checks.some((c) => c.reason.includes("database dump")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("static site does not require database", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp2-"));
  try {
    makeBackup(dir, "static.example", "static", false, 1);
    const wRoot = path.join(dir, "websites"); fs.mkdirSync(wRoot);
    const sRoot = path.join(dir, "sources"); fs.mkdirSync(sRoot);
    const result = await runPreflight({
      isStandby: true, sites: [{ host: "static.example", siteType: "static" }],
      backupsRoot: dir, websitesRoot: wRoot, sourcesRoot: sRoot,
    });
    assert.equal(result.ready, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Generic PHP requires database only when manifest.database is non-null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp2-"));
  try {
    makeBackup(dir, "generic.example", "generic-php", false, 1);
    const wRoot = path.join(dir, "websites"); fs.mkdirSync(wRoot);
    const sRoot = path.join(dir, "sources"); fs.mkdirSync(sRoot);
    const result = await runPreflight({
      isStandby: true, sites: [{ host: "generic.example", siteType: "generic-php" }],
      backupsRoot: dir, websitesRoot: wRoot, sourcesRoot: sRoot,
    });
    assert.equal(result.ready, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("rejects manifest with checksum or size mismatch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp2-"));
  try {
    makeBackup(dir, "example.com", "wordpress", true, 1);
    const setDir = path.join(dir, "example.com", fs.readdirSync(path.join(dir, "example.com"))[0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(setDir, "manifest.json"), "utf8"));
    manifest.artifacts["website.tar.gz"].size = 999; // wrong size
    fs.writeFileSync(path.join(setDir, "manifest.json"), JSON.stringify(manifest));
    const wRoot = path.join(dir, "websites"); fs.mkdirSync(wRoot);
    const sRoot = path.join(dir, "sources"); fs.mkdirSync(sRoot);
    const result = await runPreflight({
      isStandby: true, sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: dir, websitesRoot: wRoot, sourcesRoot: sRoot,
    });
    assert.equal(result.ready, false);
    assert.ok(result.checks.some((c) => c.reason.includes("artifact verification")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("rejects corrupt gzip database", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp2-"));
  try {
    makeBackup(dir, "example.com", "wordpress", true, 1);
    const setDir = path.join(dir, "example.com", fs.readdirSync(path.join(dir, "example.com"))[0]);
    fs.writeFileSync(path.join(setDir, "database.sql.gz"), "not real gzip");
    const wRoot = path.join(dir, "websites"); fs.mkdirSync(wRoot);
    const result = await runPreflight({
      isStandby: true, sites: [{ host: "example.com", siteType: "wordpress" }],
      backupsRoot: dir, websitesRoot: wRoot, sourcesRoot: dir,
    });
    assert.equal(result.ready, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("readSiteManifest rejects invalid versions, types, and fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp2-"));
  try {
    const ok = path.join(dir, "ok.json");
    fs.writeFileSync(ok, JSON.stringify({ version: 2, type: "site", domain: "x.com", websitePath: "x.com", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), artifacts: { "website.tar.gz": { size: 1, sha256: "a".repeat(64) } } }));
    assert.ok(readSiteManifest(ok));
    const wrongVersion = path.join(dir, "v1.json");
    fs.writeFileSync(wrongVersion, JSON.stringify({ version: 1, type: "site" }));
    assert.equal(readSiteManifest(wrongVersion), null);
    const badArtifacts = path.join(dir, "bad.json");
    fs.writeFileSync(badArtifacts, JSON.stringify({ version: 2, type: "site", domain: "x.com", websitePath: "x", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), artifacts: { "website.tar.gz": "not-an-object" } }));
    assert.equal(readSiteManifest(badArtifacts), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("no secrets in results", async () => {
  const result = await runPreflight({ isStandby: false, sites: [], backupsRoot: "/tmp" });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});