const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { ProvisionImportStore, validateArchiveEntry } = require("../lib/provision-import-store");

function requestFor(buffer) {
  const request = Readable.from(buffer);
  request.headers = { "content-length": String(buffer.length) };
  return request;
}

test("streams and prepares a nested WordPress TAR archive with a plain SQL dump", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provision-import-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source", "backup", "public_html");
  fs.mkdirSync(path.join(source, "wp-content"), { recursive: true });
  fs.writeFileSync(path.join(source, "wp-config.php"), "<?php // fixture\n");
  fs.writeFileSync(path.join(source, "index.php"), "<?php\n");
  const archive = path.join(root, "website.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", path.join(root, "source"), "backup"]);

  const store = new ProvisionImportStore({ importsRoot: path.join(root, "imports") });
  const id = "11111111-1111-4111-8111-111111111111";
  await store.upload(requestFor(fs.readFileSync(archive)), id, "website", "backup.tar.gz");
  await store.upload(requestFor(Buffer.from("CREATE TABLE fixture (id INT);\n")), id, "database", "site.sql");
  const prepared = await store.prepare(id, "example.com");

  const entries = execFileSync("tar", ["-tzf", path.join(prepared.sourceDirectory, prepared.websiteArchive)], { encoding: "utf8" });
  assert.match(entries, /example\.com\/wp-config\.php/);
  assert.equal(
    zlib.gunzipSync(fs.readFileSync(path.join(prepared.sourceDirectory, prepared.databaseDump))).toString(),
    "CREATE TABLE fixture (id INT);\n",
  );
});

test("rejects unsafe archive paths and unsupported upload names", async (context) => {
  assert.throws(() => validateArchiveEntry("../wp-config.php"), /unsafe path/);
  assert.throws(() => validateArchiveEntry("/etc/passwd"), /unsafe path/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provision-import-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ProvisionImportStore({ importsRoot: path.join(root, "imports") });
  await assert.rejects(
    store.upload(requestFor(Buffer.from("bad")), "22222222-2222-4222-8222-222222222222", "website", "website.rar"),
    /not supported/,
  );
});

test("rejects TAR archives containing symbolic links", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provision-import-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "wp-config.php"), "<?php\n");
  fs.symlinkSync("wp-config.php", path.join(source, "config-link.php"));
  const archive = path.join(root, "linked.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", root, "source"]);
  const store = new ProvisionImportStore({ importsRoot: path.join(root, "imports") });
  const id = "33333333-3333-4333-8333-333333333333";
  await store.upload(requestFor(fs.readFileSync(archive)), id, "website", "linked.tar.gz");
  await store.upload(requestFor(Buffer.from("SELECT 1;\n")), id, "database", "site.sql");
  await assert.rejects(store.prepare(id, "example.com"), /regular files and directories/);
});

test("prepares a ZIP archive and an already compressed SQL dump", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provision-import-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "public_html");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "wp-config.php"), "<?php\n");
  fs.writeFileSync(path.join(source, "index.php"), "<?php\n");
  const archive = path.join(root, "website.zip");
  execFileSync("zip", ["-qr", archive, "public_html"], { cwd: root });
  const compressedSql = zlib.gzipSync(Buffer.from("CREATE TABLE zipped (id INT);\n"));
  const store = new ProvisionImportStore({ importsRoot: path.join(root, "imports") });
  const id = "44444444-4444-4444-8444-444444444444";
  await store.upload(requestFor(fs.readFileSync(archive)), id, "website", "website.zip");
  await store.upload(requestFor(compressedSql), id, "database", "site.sql.gz");
  const prepared = await store.prepare(id, "zip.example.com");
  assert.equal(
    zlib.gunzipSync(fs.readFileSync(path.join(prepared.sourceDirectory, prepared.databaseDump))).toString(),
    "CREATE TABLE zipped (id INT);\n",
  );
});
