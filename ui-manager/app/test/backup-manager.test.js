const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BackupManager } = require("../lib/backup-manager");

function managerFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-backup-test-"));
  const dataDir = path.join(root, "data");
  const backupsRoot = path.join(root, "backups");
  const websitesRoot = path.join(root, "websites");
  const appDataRoot = path.join(root, "app-data");
  for (const directory of [dataDir, backupsRoot, websitesRoot, appDataRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const manager = new BackupManager({
    dataDir,
    backupsRoot,
    websitesRoot,
    appDataRoot,
    siteProvider: async () => [],
  });
  return { root, manager, backupsRoot, websitesRoot };
}

test("validates and persists backup settings", () => {
  const fixture = managerFixture();
  try {
    const settings = fixture.manager.updateSettings({
      scheduleTime: "22:35",
      retention: 14,
      siteBackupsEnabled: false,
      appDataEnabled: false,
    });
    assert.equal(settings.scheduleTime, "22:35");
    assert.equal(settings.retention, 14);
    assert.equal(settings.siteBackupsEnabled, false);
    assert.equal(settings.appDataEnabled, false);
    assert.throws(() => fixture.manager.updateSettings({ retention: 0 }), /between 1 and 90/);
    assert.throws(() => fixture.manager.updateSettings({ scheduleTime: "25:00" }), /HH:MM/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("global pause blocks manual website backups", async () => {
  const fixture = managerFixture();
  try {
    fixture.manager.updateSettings({ siteBackupsEnabled: false });
    await assert.rejects(
      fixture.manager.runSite({ host: "example.com", root: "/var/www/example.com" }),
      /temporarily disabled/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed daily run remains eligible for a later retry", async () => {
  const fixture = managerFixture();
  try {
    fixture.manager.updateSettings({
      scheduleTime: "00:00",
      siteBackupsEnabled: false,
      appDataEnabled: true,
      lastScheduledDate: "",
    });
    fixture.manager.createAppDataBackup = async () => {
      throw new Error("database is starting");
    };
    const result = await fixture.manager.runScheduled(new Date("2026-07-20T12:00:00"));
    assert.equal(result.ok, false);
    assert.equal(fixture.manager.readSettings().lastScheduledDate, "");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("keeps complete backup sets according to retention", () => {
  const fixture = managerFixture();
  try {
    const parent = fixture.manager.safeBackupParent("example.com");
    for (const id of [
      "2026-07-18T03-00-00Z",
      "2026-07-19T03-00-00Z",
      "2026-07-20T03-00-00Z",
    ]) {
      const directory = path.join(parent, id);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ id, type: "site" }));
      fs.writeFileSync(path.join(directory, "website.tar.gz"), id);
      fs.writeFileSync(path.join(directory, "database.sql.gz"), id);
    }
    fixture.manager.applyRetention("example.com", 2);
    assert.deepEqual(
      fixture.manager.history("example.com").map((backup) => backup.id),
      ["2026-07-20T03-00-00Z", "2026-07-19T03-00-00Z"],
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects document roots outside the websites mount", () => {
  const fixture = managerFixture();
  try {
    fs.mkdirSync(path.join(fixture.websitesRoot, "valid.example"));
    assert.equal(
      fixture.manager.siteRelativePath({ host: "valid.example", root: "/var/www/valid.example" }),
      "valid.example",
    );
    assert.throws(
      () => fixture.manager.siteRelativePath({ host: "bad.example", root: "/var/www/../../etc" }),
      /Unsafe document root/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("allocates a different identifier when two backups start in the same second", () => {
  const fixture = managerFixture();
  try {
    const parent = fixture.manager.safeBackupParent("example.com");
    const now = new Date("2026-07-20T03:00:00Z");
    const first = fixture.manager.nextBackupId(parent, now);
    fs.mkdirSync(path.join(parent, first));
    const second = fixture.manager.nextBackupId(parent, now);
    assert.equal(first, "2026-07-20T03-00-00Z");
    assert.equal(second, "2026-07-20T03-00-01Z");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a site restore when the manifest belongs to another host", () => {
  const fixture = managerFixture();
  try {
    const id = "2026-07-20T03-00-00Z";
    const directory = path.join(fixture.manager.safeBackupParent("example.com"), id);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({
      type: "site",
      domain: "other.example",
    }));
    fs.writeFileSync(path.join(directory, "website.tar.gz"), "archive");
    fs.writeFileSync(path.join(directory, "database.sql.gz"), "database");
    assert.throws(
      () => fixture.manager.readSiteManifest({ host: "example.com" }, id),
      /does not belong/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
