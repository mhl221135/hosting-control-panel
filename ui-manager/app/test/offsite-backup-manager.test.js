const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { JobManager } = require("../lib/job-manager");
const {
  OffsiteBackupManager,
  OffsiteSettings,
  isoWeek,
} = require("../lib/offsite-backup-manager");

function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "offsite-backup-"));
}

function crypt(value) {
  return value ? `encrypted:${Buffer.from(value).toString("base64")}` : "";
}

function decrypt(value) {
  return value?.startsWith("encrypted:") ? Buffer.from(value.slice(10), "base64").toString() : "";
}

function configuredSettings(settings) {
  return settings.update({
    enabled: true,
    endpoint: "https://objects.example.test",
    bucket: "hosting-backups",
    prefix: "production",
    region: "us-east-1",
    accessKeyId: "access",
    secretAccessKey: "secret",
    repositoryPassword: "repository-password",
    scheduleTime: "05:30",
    retention: 14,
    verifyPercent: 3,
    restoreTestMaxBytes: 1073741824,
  });
}

test("off-site settings encrypt secrets and expose configuration flags only", () => {
  const dataDir = temporary();
  const settings = new OffsiteSettings({ dataDir, encrypt: crypt, decrypt });
  const visible = configuredSettings(settings);
  const disk = fs.readFileSync(path.join(dataDir, "offsite-backup-settings.json"), "utf8");
  assert.equal(visible.configured, true);
  assert.equal(visible.repositoryPasswordConfigured, true);
  assert.equal(disk.includes("repository-password"), false);
  assert.equal(JSON.stringify(visible).includes("repository-password"), false);
});

test("off-site settings reject insecure endpoints", () => {
  const settings = new OffsiteSettings({ dataDir: temporary(), encrypt: crypt, decrypt });
  assert.throws(() => settings.update({ endpoint: "http://objects.example.test" }), /HTTPS/);
});

test("sync excludes partial data, verifies, retains, and shares backup lock", async () => {
  const dataDir = temporary();
  const backupsRoot = path.join(dataDir, "backups");
  fs.mkdirSync(backupsRoot);
  const calls = [];
  let locked = false;
  const jobManager = new JobManager({ dataDir: path.join(dataDir, "jobs") });
  const manager = new OffsiteBackupManager({
    dataDir,
    backupsRoot,
    jobManager,
    backupManager: {
      withLock: async (_job, work) => {
        locked = true;
        return work();
      },
    },
    encrypt: crypt,
    decrypt,
    runner: async (args) => {
      calls.push(args);
      return {
        stdout: args[0] === "snapshots"
          ? JSON.stringify([{ time: new Date().toISOString(), id: "snapshot" }])
          : "[]",
      };
    },
  });
  configuredSettings(manager.settings);
  const updates = [];
  const result = await manager.sync({
    update: (patch) => updates.push(patch),
    checkpoint: () => {},
  });
  assert.equal(locked, true);
  assert.equal(result.ok, true);
  assert.equal(calls[0][0], "backup");
  assert.equal(calls[0].includes("**/.partial-*"), true);
  assert.equal(calls[1][0], "snapshots");
  assert.deepEqual(calls[2], ["check", "--read-data-subset", "3%"]);
  assert.equal(calls[3][0], "forget");
  assert.equal(calls[4][0], "prune");
  assert.equal(updates.at(-1).completed, 3);
});

test("restore test uses an isolated path and removes it after validation", async () => {
  const dataDir = temporary();
  const backupsRoot = path.join(dataDir, "backups");
  const source = path.join(backupsRoot, "example.test", "2026-01-01T00-00-00Z");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ ok: true }));
  fs.writeFileSync(path.join(source, "website.tar.gz"), "archive");
  const jobManager = new JobManager({ dataDir: path.join(dataDir, "jobs") });
  const manager = new OffsiteBackupManager({
    dataDir,
    backupsRoot,
    jobManager,
    backupManager: { withLock: async (_job, work) => work() },
    encrypt: crypt,
    decrypt,
    runner: async (args) => {
      if (args[0] === "restore") {
        const target = args[args.indexOf("--target") + 1];
        const include = args[args.indexOf("--include") + 1];
        const restored = path.join(target, include);
        fs.mkdirSync(restored, { recursive: true });
        fs.copyFileSync(path.join(source, "manifest.json"), path.join(restored, "manifest.json"));
        fs.copyFileSync(path.join(source, "website.tar.gz"), path.join(restored, "website.tar.gz"));
      }
      return { stdout: "[]" };
    },
  });
  configuredSettings(manager.settings);
  const result = await manager.restoreTest({ update: () => {} });
  assert.equal(result.ok, true);
  assert.equal(fs.readdirSync(manager.restoreRoot).length, 0);
});

test("ISO week key is stable within the same week", () => {
  assert.equal(isoWeek(new Date("2026-07-19T10:00:00Z")), isoWeek(new Date("2026-07-19T18:00:00Z")));
});
