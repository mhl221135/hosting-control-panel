const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { DeepVerifyManager, verifyTar } = require("../lib/deep-verify-manager.js");
const { JobCancelledError } = require("../lib/job-manager.js");

function mockContext(cancelled = false) {
  return {
    update: () => {},
    checkpoint: () => {
      if (cancelled) {
        const e = new JobCancelledError('cancelled');
        throw e;
      }
    },
    cancellationRequested: () => cancelled,
  };
}

const mockJobManager = {
  handlers: new Map(),
  register: function(type, handler) {
    this.handlers.set(type, handler);
  },
};

function createValidBackup(tmpDir, domain, setId) {
  const setDir = path.join(tmpDir, domain, setId);
  fs.mkdirSync(setDir, { recursive: true });

  const websiteSrc = path.join(tmpDir, "website_src");
  fs.mkdirSync(path.join(websiteSrc, "public_html"), { recursive: true });
  fs.writeFileSync(path.join(websiteSrc, "public_html", "index.html"), "<h1>Hello</h1>");

  const websiteArchive = path.join(setDir, "website.tar.gz");
  execFileSync('tar', ['-czf', websiteArchive, '-C', websiteSrc, 'public_html']);
  const websiteSize = fs.statSync(websiteArchive).size;
  const websiteHash = crypto.createHash('sha256').update(fs.readFileSync(websiteArchive)).digest('hex');

  const dbSrcContent = "CREATE DATABASE test;";
  const dbArchive = path.join(setDir, "database.sql.gz");
  execFileSync('gzip', ['-c'], { input: dbSrcContent });
  // Need to correctly write gzip output to file
  const gzipOut = execFileSync('gzip', ['-c'], { input: dbSrcContent });
  fs.writeFileSync(dbArchive, gzipOut);

  const dbSize = fs.statSync(dbArchive).size;
  const dbHash = crypto.createHash('sha256').update(fs.readFileSync(dbArchive)).digest('hex');

  const manifest = {
    version: 2,
    type: "site",
    id: setId,
    domain: domain,
    websitePath: "public_html",
    database: "test_db",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    artifacts: {
      "website.tar.gz": { size: websiteSize, sha256: websiteHash },
      "database.sql.gz": { size: dbSize, sha256: dbHash }
    }
  };
  fs.writeFileSync(path.join(setDir, "manifest.json"), JSON.stringify(manifest));
  const manifestHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(setDir, "manifest.json"))).digest('hex');
  return manifestHash;
}

test("DeepVerifyManager tests", async (t) => {
  let tmpDir;

  t.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'deep-verify-test-'));
  });

  t.afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("Test successful verification writes atomic receipt", async () => {
    const domain = "example.com";
    const setId = "2024-01-01T12-00-00Z";

    const manifestHash = createValidBackup(tmpDir, domain, setId);

    const rcpt = {
      version: 1,
      result: "success",
      sourceServerId: "primary-test",
      completedAt: "2024-01-01T12:01:00Z",
      verifiedCount: 1,
      sets: [
        { domain, setId, manifestSha256: manifestHash }
      ]
    };
    fs.writeFileSync(path.join(tmpDir, "receiver-state.json"), JSON.stringify(rcpt));

    const manager = new DeepVerifyManager({ jobManager: mockJobManager, backupsRoot: tmpDir });
    const result = await manager.runDeepVerify(mockContext());

    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(tmpDir, "deep-verify-state.json")), true);

    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, "deep-verify-state.json"), "utf8"));
    assert.equal(state.result, "success");
    assert.equal(state.verifiedCount, 1);
    assert.match(state.receiverReceiptSha256, /^[a-f0-9]{64}$/);
    assert.equal(state.verifiedSets[0].domain, domain);
  });

  await t.test("Test checksum mismatch throws error", async () => {
    const domain = "example.com";
    const setId = "2024-01-01T12-00-00Z";
    const manifestHash = createValidBackup(tmpDir, domain, setId);

    // Corrupt archive
    const dbArchive = path.join(tmpDir, domain, setId, "database.sql.gz");
    const content = fs.readFileSync(dbArchive);
    content[0] ^= 0xFF; // Flip some bits
    fs.writeFileSync(dbArchive, content);

    const rcpt = {
      version: 1,
      result: "success",
      sourceServerId: "primary-test",
      completedAt: "2024-01-01T12:01:00Z",
      verifiedCount: 1,
      sets: [
        { domain, setId, manifestSha256: manifestHash }
      ]
    };
    fs.writeFileSync(path.join(tmpDir, "receiver-state.json"), JSON.stringify(rcpt));

    const manager = new DeepVerifyManager({ jobManager: mockJobManager, backupsRoot: tmpDir });
    await assert.rejects(
      manager.runDeepVerify(mockContext()),
      (err) => /checksum mismatch|size mismatch/i.test(err.message)
    );
  });

  await t.test("Test path traversal in domain rejected", async () => {
    const domain = "../bad-domain";
    const setId = "2024-01-01T12-00-00Z";

    const rcpt = {
      version: 1,
      result: "success",
      sourceServerId: "primary-test",
      completedAt: "2024-01-01T12:01:00Z",
      verifiedCount: 1,
      sets: [
        { domain, setId, manifestSha256: "0".repeat(64) }
      ]
    };
    fs.writeFileSync(path.join(tmpDir, "receiver-state.json"), JSON.stringify(rcpt));

    const manager = new DeepVerifyManager({ jobManager: mockJobManager, backupsRoot: tmpDir });
    await assert.rejects(
      manager.runDeepVerify(mockContext()),
      (err) => /receiver receipt is invalid|invalid domain/i.test(err.message)
    );
  });

  await t.test("Test path traversal in setId rejected", async () => {
    const domain = "example.com";
    const setId = "../2024-01-01T12-00-00Z";

    const rcpt = {
      version: 1,
      result: "success",
      sourceServerId: "primary-test",
      completedAt: "2024-01-01T12:01:00Z",
      verifiedCount: 1,
      sets: [
        { domain, setId, manifestSha256: "0".repeat(64) }
      ]
    };
    fs.writeFileSync(path.join(tmpDir, "receiver-state.json"), JSON.stringify(rcpt));

    const manager = new DeepVerifyManager({ jobManager: mockJobManager, backupsRoot: tmpDir });
    await assert.rejects(
      manager.runDeepVerify(mockContext()),
      (err) => /receiver receipt is invalid|invalid set/i.test(err.message)
    );
  });

  await t.test("Test cancellation during hashing", async () => {
    const domain = "example.com";
    const setId = "2024-01-01T12-00-00Z";
    const manifestHash = createValidBackup(tmpDir, domain, setId);

    const rcpt = {
      version: 1,
      result: "success",
      sourceServerId: "primary-test",
      completedAt: "2024-01-01T12:01:00Z",
      verifiedCount: 1,
      sets: [
        { domain, setId, manifestSha256: manifestHash }
      ]
    };
    fs.writeFileSync(path.join(tmpDir, "receiver-state.json"), JSON.stringify(rcpt));

    const manager = new DeepVerifyManager({ jobManager: mockJobManager, backupsRoot: tmpDir });

    let cancelled = false;
    const ctx = {
      update: () => {},
      checkpoint: () => {
        if (cancelled) throw new JobCancelledError('cancelled');
      },
      cancellationRequested: () => cancelled,
    };

    // We will wait a tiny bit then cancel
    setTimeout(() => { cancelled = true; }, 1);

    await assert.rejects(
      manager.runDeepVerify(ctx),
      (err) => err.code === "JOB_CANCELLED" || err.message === "cancelled" || err.message === "Cancelled during hashing"
    );
  });

  await t.test("verifies the production app-data manifest format", async () => {
    const setId = "2024-01-01T12-00-00Z";
    const setDir = path.join(tmpDir, "app-data", setId);
    const source = path.join(tmpDir, "app-source");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(setDir, { recursive: true });
    fs.writeFileSync(path.join(source, "settings.json"), "{}");
    execFileSync("tar", ["-czf", path.join(setDir, "app-data.tar.gz"), "-C", source, "."]);
    fs.writeFileSync(path.join(setDir, "databases.sql.gz"), execFileSync("gzip", ["-c"], { input: "SELECT 1;" }));
    const artifact = (name) => {
      const data = fs.readFileSync(path.join(setDir, name));
      return { size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
    };
    const manifest = {
      version: 2, type: "app-data", id: setId, excluded: ["mysql", "nginx-cache"],
      startedAt: "2024-01-01T12:00:00Z", completedAt: "2024-01-01T12:01:00Z",
      artifacts: { "app-data.tar.gz": artifact("app-data.tar.gz"), "databases.sql.gz": artifact("databases.sql.gz") },
    };
    fs.writeFileSync(path.join(setDir, "manifest.json"), JSON.stringify(manifest));
    const manifestSha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(setDir, "manifest.json"))).digest("hex");
    fs.writeFileSync(path.join(tmpDir, "receiver-state.json"), JSON.stringify({
      version: 1, result: "success", sourceServerId: "primary-test", completedAt: "2024-01-01T12:01:00Z",
      verifiedCount: 1, sets: [{ domain: "app-data", setId, manifestSha256 }],
    }));
    const manager = new DeepVerifyManager({ jobManager: mockJobManager, backupsRoot: tmpDir });
    assert.equal((await manager.runDeepVerify(mockContext())).ok, true);
  });

  await t.test("rejects symlinks in website archives", async () => {
    const source = path.join(tmpDir, "link-source");
    fs.mkdirSync(path.join(source, "public_html"), { recursive: true });
    fs.symlinkSync("/etc/passwd", path.join(source, "public_html", "linked"));
    const archive = path.join(tmpDir, "links.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", source, "public_html"]);
    await assert.rejects(verifyTar(archive, "public_html", mockContext(), Date.now() + 10_000), /link or special file/);
  });

  await t.test("allows confined app-data symlinks to archived regular files", async () => {
    const source = path.join(tmpDir, "cert-source");
    fs.mkdirSync(path.join(source, "npm/letsencrypt/archive/site"), { recursive: true });
    fs.mkdirSync(path.join(source, "npm/letsencrypt/live/site"), { recursive: true });
    fs.writeFileSync(path.join(source, "npm/letsencrypt/archive/site/cert1.pem"), "certificate");
    fs.symlinkSync("../../archive/site/cert1.pem", path.join(source, "npm/letsencrypt/live/site/cert.pem"));
    const archive = path.join(tmpDir, "certs.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", source, "."]);
    await verifyTar(archive, null, mockContext(), Date.now() + 10_000, { allowConfinedSymlinks: true });
  });

  await t.test("rejects escaping app-data symlinks", async () => {
    const source = path.join(tmpDir, "escape-source");
    fs.mkdirSync(path.join(source, "config"), { recursive: true });
    fs.symlinkSync("../../outside", path.join(source, "config/escape"));
    const archive = path.join(tmpDir, "escape.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", source, "."]);
    await assert.rejects(
      verifyTar(archive, null, mockContext(), Date.now() + 10_000, { allowConfinedSymlinks: true }),
      /unsafe symlink/,
    );
  });
});
