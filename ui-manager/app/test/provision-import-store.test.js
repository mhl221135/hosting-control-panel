const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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

function chunkRequest(buffer, start, end, total) {
  const request = requestFor(buffer.subarray(start, end));
  request.headers["content-range"] = `bytes ${start}-${end - 1}/${total}`;
  return request;
}

function checksum(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("assembles a resumable upload from ordered chunks", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provision-import-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ProvisionImportStore({ importsRoot: path.join(root, "imports") });
  const id = "55555555-5555-4555-8555-555555555555";
  const contents = Buffer.from("chunk-one|chunk-two|chunk-three");

  const first = await store.upload(chunkRequest(contents, 0, 10, contents.length), id, "database", "site.sql");
  const second = await store.upload(chunkRequest(contents, 10, 20, contents.length), id, "database", "site.sql");
  const third = await store.upload(chunkRequest(contents, 20, contents.length, contents.length), id, "database", "site.sql");

  assert.equal(first.complete, false);
  assert.equal(second.received, 20);
  assert.equal(third.complete, true);
  assert.deepEqual(fs.readFileSync(path.join(store.directory(id), "database-upload.sql")), contents);
  assert.equal(store.read(id).files.database.size, contents.length);
});

test("rejects an out-of-order resumable chunk without discarding prior chunks", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provision-import-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ProvisionImportStore({ importsRoot: path.join(root, "imports") });
  const id = "66666666-6666-4666-8666-666666666666";
  const contents = Buffer.from("0123456789abcdefghij");

  await store.upload(chunkRequest(contents, 0, 10, contents.length), id, "database", "site.sql");
  await assert.rejects(
    store.upload(chunkRequest(contents, 15, contents.length, contents.length), id, "database", "site.sql"),
    /offset mismatch/,
  );
  assert.equal(fs.statSync(path.join(store.directory(id), "database-upload.sql.partial")).size, 10);
});

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
  assert.equal(validateArchiveEntry("./"), "");
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

test("safely skips symbolic links in website TAR archives", async (context) => {
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
  const prepared = await store.prepare(id, "example.com");
  const entries = execFileSync("tar", ["-tzf", path.join(prepared.sourceDirectory, prepared.websiteArchive)], { encoding: "utf8" });
  assert.match(entries, /example\.com\/wp-config\.php/);
  assert.doesNotMatch(entries, /config-link\.php/);
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

test("extracts exactly one SQL dump from a database TAR.GZ archive", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provision-import-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const website = path.join(root, "public_html");
  fs.mkdirSync(website);
  fs.writeFileSync(path.join(website, "wp-config.php"), "<?php\n");
  const websiteArchive = path.join(root, "website.tar.gz");
  execFileSync("tar", ["-czf", websiteArchive, "public_html"], { cwd: root });

  const dumps = path.join(root, "dumps");
  fs.mkdirSync(dumps);
  fs.writeFileSync(path.join(dumps, "example.sql"), "CREATE TABLE archived (id INT);\n");
  const databaseArchive = path.join(root, "database.tar.gz");
  execFileSync("tar", ["-czf", databaseArchive, "dumps"], { cwd: root });

  const store = new ProvisionImportStore({ importsRoot: path.join(root, "imports") });
  const id = "77777777-7777-4777-8777-777777777777";
  await store.upload(requestFor(fs.readFileSync(websiteArchive)), id, "website", "website.tar.gz");
  await store.upload(requestFor(fs.readFileSync(databaseArchive)), id, "database", "database.tar.gz");
  const prepared = await store.prepare(id, "archive.example.com");

  assert.equal(
    zlib.gunzipSync(fs.readFileSync(path.join(prepared.sourceDirectory, prepared.databaseDump))).toString(),
    "CREATE TABLE archived (id INT);\n",
  );
});

test("prepares a Generic PHP database dump without requiring WordPress files", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provision-generic-db-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ProvisionImportStore({ importsRoot: path.join(root, "imports") });
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await store.upload(
    requestFor(Buffer.from("CREATE TABLE generic_fixture (id INT);\n")),
    id,
    "database",
    "generic.sql",
  );

  const prepared = await store.prepareDatabaseDump(id);
  assert.equal(
    zlib.gunzipSync(fs.readFileSync(prepared)).toString(),
    "CREATE TABLE generic_fixture (id INT);\n",
  );
});

test("installs a static website archive without wp-config or a database", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provision-static-import-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "site");
  fs.mkdirSync(path.join(source, "assets"), { recursive: true });
  fs.writeFileSync(path.join(source, "index.html"), "<h1>Static site</h1>\n");
  fs.writeFileSync(path.join(source, "contact.php"), "<?php echo 'ok';\n");
  fs.writeFileSync(path.join(source, "assets", "site.css"), "body {}\n");
  const archive = path.join(root, "site.tar.gz");
  execFileSync("tar", ["-czf", archive, "site"], { cwd: root });

  const store = new ProvisionImportStore({ importsRoot: path.join(root, "imports") });
  const id = "88888888-8888-4888-8888-888888888888";
  await store.upload(requestFor(fs.readFileSync(archive)), id, "website", "site.tar.gz");
  const destination = path.join(root, "destination");
  fs.mkdirSync(destination);
  const result = await store.installWebsiteArchive(id, destination);

  assert.equal(result.fileCount, 3);
  assert.equal(fs.readFileSync(path.join(destination, "index.html"), "utf8"), "<h1>Static site</h1>\n");
  assert.equal(fs.readFileSync(path.join(destination, "contact.php"), "utf8"), "<?php echo 'ok';\n");
  assert.equal(fs.readFileSync(path.join(destination, "assets", "site.css"), "utf8"), "body {}\n");
});

test("validates and stages a complete portable bundle for Transfers", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-bundle-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const portable = path.join(root, "portable", "export-2026-07-27_12-00-00");
  fs.mkdirSync(path.join(portable, "sites"), { recursive: true });
  fs.mkdirSync(path.join(portable, "databases"), { recursive: true });
  fs.writeFileSync(path.join(portable, "sites", "example.tar.gz"), "website archive");
  fs.writeFileSync(path.join(portable, "databases", "example.sql.gz"), "database dump");
  fs.writeFileSync(path.join(portable, "manifest.json"), JSON.stringify({
    version: 1,
    type: "hosting-sites-export",
    sites: [{
      domain: "example.com",
      websitePath: "example.com",
      database: "example_db",
      websiteArchive: "sites/example.tar.gz",
      databaseDump: "databases/example.sql.gz",
    }],
  }));
  const covered = ["manifest.json", "sites/example.tar.gz", "databases/example.sql.gz"];
  fs.writeFileSync(path.join(portable, "checksums.sha256"), `${covered.map((relative) =>
    `${checksum(path.join(portable, relative))}  ${relative}`).join("\n")}\n`);
  const archive = path.join(root, "portable.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", path.join(root, "portable"), path.basename(portable)]);

  const importsRoot = path.join(root, "imports");
  const store = new ProvisionImportStore({ importsRoot });
  const id = "99999999-9999-4999-8999-999999999999";
  await store.upload(requestFor(fs.readFileSync(archive)), id, "bundle", "portable.tar.gz");
  assert.equal(store.bundleUploadStatus(id).complete, true);
  const result = await store.prepareBundle(id);

  assert.equal(result.source, `upload-${id}`);
  assert.equal(fs.existsSync(path.join(importsRoot, result.source, "manifest.json")), true);
  assert.equal(fs.existsSync(store.directory(id)), false);
});

test("retains a portable bundle upload when checksum validation fails", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-bundle-invalid-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const portable = path.join(root, "portable");
  fs.mkdirSync(path.join(portable, "sites"), { recursive: true });
  fs.writeFileSync(path.join(portable, "sites", "static.tar.gz"), "archive");
  fs.writeFileSync(path.join(portable, "manifest.json"), JSON.stringify({
    version: 1,
    type: "hosting-sites-export",
    sites: [{
      domain: "static.example.com",
      siteType: "static",
      websitePath: "static.example.com",
      websiteArchive: "sites/static.tar.gz",
    }],
  }));
  fs.writeFileSync(path.join(portable, "checksums.sha256"), `${"0".repeat(64)}  manifest.json\n${"0".repeat(64)}  sites/static.tar.gz\n`);
  const archive = path.join(root, "portable.zip");
  execFileSync("zip", ["-qr", archive, "."], { cwd: portable });
  const store = new ProvisionImportStore({ importsRoot: path.join(root, "imports") });
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await store.upload(requestFor(fs.readFileSync(archive)), id, "bundle", "portable.zip");

  await assert.rejects(store.prepareBundle(id), /checksum failed/);
  assert.equal(fs.existsSync(store.directory(id)), true);
  assert.equal(store.bundleUploadStatus(id).complete, true);
});
