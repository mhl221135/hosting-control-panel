const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const {
  BackupManager,
  MYSQL_RESTORE_SQL_MODE,
  NPM_BACKUP_READ_SCRIPT,
  artifactManifest,
  setBackupSetPermissions,
  verifyArtifactManifest,
  writeHashedProcessOutput,
} = require("../lib/backup-manager");

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

test("site restore mode accepts legacy zero-date schemas without weakening global MySQL mode", () => {
  assert.match(MYSQL_RESTORE_SQL_MODE, /STRICT_TRANS_TABLES/);
  assert.doesNotMatch(MYSQL_RESTORE_SQL_MODE, /NO_ZERO_DATE|NO_ZERO_IN_DATE/);
});

test("app-data backup uses the exact allowlisted NPM certificate-readiness command", () => {
  const { NPM_BACKUP_READ_SCRIPT: agentScript } = require("../../../control-agent/app/policy");
  assert.equal(NPM_BACKUP_READ_SCRIPT, agentScript);
  assert.match(NPM_BACKUP_READ_SCRIPT, /^set -eu; find \/etc\/letsencrypt /);
  const source = fs.readFileSync(path.join(__dirname, "../lib/backup-manager.js"), "utf8");
  assert.match(source, /"--exclude=\.\/redis"/);
  assert.match(source, /excluded: \["mysql", "redis", "nginx-cache"\]/);
  assert.doesNotMatch(source, /"--ignore-failed-read"[\s\S]{0,500}"--exclude=\.\/mysql"/);
});

test("backup sets remain private while allowing the replica group to read artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-backup-mode-"));
  try {
    fs.writeFileSync(path.join(root, "manifest.json"), "{}", { mode: 0o600 });
    fs.writeFileSync(path.join(root, "database.sql.gz"), "database", { mode: 0o600 });
    setBackupSetPermissions(root);
    assert.equal(fs.statSync(root).mode & 0o777, 0o750);
    assert.equal(fs.statSync(path.join(root, "manifest.json")).mode & 0o777, 0o640);
    assert.equal(fs.statSync(path.join(root, "database.sql.gz")).mode & 0o777, 0o640);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runs optional billing registration after a successful restore", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-restore-billing-"));
  try {
    const handlers = new Map();
    const jobManager = {
      register: (type, handler) => handlers.set(type, handler),
      create: (input) => input,
    };
    const calls = [];
    const manager = new BackupManager({
      dataDir: path.join(root, "data"),
      backupsRoot: path.join(root, "backups"),
      websitesRoot: path.join(root, "websites"),
      appDataRoot: path.join(root, "app-data"),
      jobManager,
      siteProvider: async () => [{ host: "example.com", aliases: ["www.example.com"] }],
      afterRestore: async (input) => {
        calls.push(input);
        return { created: false, service: { serviceId: "svc_example" } };
      },
    });
    manager.runSiteRestore = async () => ({
      ok: true,
      total: 1,
      completed: 1,
      results: [{ name: "restore", ok: true }],
    });
    const updates = [];
    const registration = { enabled: true, grantFreePeriod: false };
    const result = await handlers.get("backup.restore")({
      id: "11111111-1111-4111-8111-111111111111",
      update: (patch) => updates.push(patch),
    }, {
      domain: "example.com",
      backupId: "2026-07-29T00-00-00Z",
      aliases: ["www.example.com"],
      billingRegistration: registration,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].registration, registration);
    assert.equal(calls[0].idempotencyKey, "11111111-1111-4111-8111-111111111111");
    assert.equal(result.ok, true);
    assert.equal(result.total, 2);
    assert.equal(result.results[1].serviceId, "svc_example");
    assert.equal(updates.at(-1).completed, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("version 2 backup artifacts detect truncation while version 1 remains readable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-artifacts-"));
  try {
    fs.writeFileSync(path.join(directory, "website.tar.gz"), "complete archive");
    const artifacts = await artifactManifest(directory, ["website.tar.gz"]);
    assert.deepEqual(
      await verifyArtifactManifest(directory, { version: 2, artifacts }, ["website.tar.gz"]),
      { checksums: true, legacy: false },
    );
    fs.appendFileSync(path.join(directory, "website.tar.gz"), "tampered");
    await assert.rejects(
      verifyArtifactManifest(directory, { version: 2, artifacts }, ["website.tar.gz"]),
      /checksum failed/,
    );
    assert.deepEqual(
      await verifyArtifactManifest(directory, { version: 1 }, ["website.tar.gz"]),
      { checksums: false, legacy: true },
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("hashes process output while writing and removes failed output", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-stream-hash-"));
  const output = path.join(directory, "archive.tar.gz");
  try {
    const artifact = await writeHashedProcessOutput(process.execPath, ["-e", "process.stdout.write('archive bytes')"], output);
    assert.equal(artifact.size, 13);
    assert.equal(artifact.sha256, require("node:crypto").createHash("sha256").update("archive bytes").digest("hex"));
    assert.equal(fs.readFileSync(output, "utf8"), "archive bytes");
    await assert.rejects(
      writeHashedProcessOutput(process.execPath, ["-e", "process.stdout.write('partial'); process.exit(2)"], output),
      /archive failed/,
    );
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects website symlinks before creating a backup set", async () => {
  const fixture = managerFixture();
  const siteRoot = path.join(fixture.websitesRoot, "example.com");
  try {
    fs.mkdirSync(siteRoot, { recursive: true });
    fs.writeFileSync(path.join(siteRoot, "index.php"), "<?php echo 'ok';");
    fs.symlinkSync("index.php", path.join(siteRoot, "linked.php"));
    await assert.rejects(
      fixture.manager.createSiteBackup({
        host: "example.com",
        root: "/var/www/example.com",
        state: { siteType: "static" },
      }, 2),
      /Website contains symbolic links/,
    );
    assert.equal(fs.existsSync(path.join(fixture.backupsRoot, "example.com")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

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
    await assert.rejects(fixture.manager.runSites(false), /temporarily disabled/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("backs up enabled sites or all primary sites sequentially", async () => {
  const fixture = managerFixture();
  try {
    fixture.manager.siteProvider = async () => [
      { host: "enabled.example", state: { backupEnabled: true } },
      { host: "disabled.example", state: { backupEnabled: false } },
      { host: "www.enabled.example", isWwwAlias: true, state: { backupEnabled: true } },
    ];
    const backedUp = [];
    fixture.manager.createSiteBackup = async (site) => {
      backedUp.push(site.host);
      return { ok: true, type: "site", domain: site.host };
    };

    const enabled = await fixture.manager.runSites(true);
    assert.deepEqual(backedUp, ["enabled.example"]);
    assert.equal(enabled.total, 1);
    assert.equal(enabled.succeeded, 1);

    backedUp.length = 0;
    const all = await fixture.manager.runSites(false);
    assert.deepEqual(backedUp, ["enabled.example", "disabled.example"]);
    assert.equal(all.total, 2);
    assert.equal(all.failed, 0);
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

test("scheduled retry skips complete same-day sites but creates app-data last", async () => {
  const fixture = managerFixture();
  try {
    fixture.manager.updateSettings({ siteBackupsEnabled: true, appDataEnabled: true });
    fixture.manager.siteProvider = async () => [
      { host: "done.example", state: { backupEnabled: true } },
      { host: "pending.example", state: { backupEnabled: true } },
    ];
    const existing = fixture.manager.safeBackupParent("done.example");
    const id = "2026-08-09T00-00-00Z";
    fs.mkdirSync(path.join(existing, id));
    fs.writeFileSync(path.join(existing, id, "manifest.json"), JSON.stringify({
      version: 2, type: "site", domain: "done.example", completedAt: "2026-08-09T01:00:00Z",
    }));
    const calls = [];
    fixture.manager.createSiteBackup = async (site) => {
      calls.push(`site:${site.host}`);
      return { type: "site", domain: site.host, ok: true };
    };
    fixture.manager.createAppDataBackup = async () => {
      calls.push("app-data");
      return { type: "app-data", ok: true };
    };
    const updates = [];
    const result = await fixture.manager.runScheduledWork({
      checkpoint() {}, update(value) { updates.push(value); },
    }, fixture.manager.localDate("2026-08-09T01:00:00Z"));
    assert.deepEqual(calls, ["site:pending.example", "app-data"]);
    assert.equal(result.results[0].skipped, true);
    assert.equal(result.results.at(-1).type, "app-data");
    assert.equal(updates.at(-1).completed, 3);
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

test("uses Generic PHP database state without invoking WordPress CLI", async () => {
  const fixture = managerFixture();
  try {
    fixture.manager.databaseName = async () => {
      throw new Error("WordPress CLI must not run");
    };
    assert.equal(await fixture.manager.siteDatabaseName({
      state: {
        siteType: "generic-php",
        databaseName: "generic_db",
        databaseUser: "generic_user",
      },
    }, "generic.example"), "generic_db");
    assert.equal(await fixture.manager.siteDatabaseName({
      state: { siteType: "generic-php" },
    }, "files.example"), null);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("uses required OpenCart database state without invoking WordPress CLI", async () => {
  const fixture = managerFixture();
  try {
    fixture.manager.databaseName = async () => {
      throw new Error("WordPress CLI must not run");
    };
    assert.equal(await fixture.manager.siteDatabaseName({
      state: {
        siteType: "opencart",
        databaseName: "cart_db",
        databaseUser: "cart_user",
      },
    }, "shop.example"), "cart_db");
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

test("verifies a complete website backup archive before controlled updates", async () => {
  const fixture = managerFixture();
  try {
    const site = {
      host: "example.com",
      root: "/var/www/example.com",
      state: { siteType: "static" },
    };
    const source = path.join(fixture.websitesRoot, "example.com");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "index.php"), "<?php echo 'ok';");
    const id = "2026-07-20T03-00-00Z";
    const directory = path.join(fixture.manager.safeBackupParent(site.host), id);
    fs.mkdirSync(directory);
    execFileSync("tar", [
      "-czf", path.join(directory, "website.tar.gz"),
      "-C", fixture.websitesRoot,
      "example.com",
    ]);
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({
      version: 1,
      type: "site",
      id,
      domain: site.host,
      websitePath: "example.com",
      database: null,
    }));
    const verification = await fixture.manager.verifySiteBackup(site, id);
    assert.equal(verification.ok, true);
    assert.equal(verification.database, false);
    assert.ok(verification.websiteEntries >= 2);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reports detailed phases while creating large backups", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../lib/backup-manager.js"), "utf8");
  for (const phase of ["Reading database settings", "Archiving files", "Dumping database", "Hashing backup", "Finalizing backup"]) {
    assert.match(source, new RegExp(phase));
  }
  for (const phase of ["Preparing certificate files", "Archiving application data", "Dumping all databases", "Hashing application-data backup"]) {
    assert.match(source, new RegExp(phase));
  }
});
