const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFile } = require("child_process");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const UPLOAD_ID_PATTERN = /^[a-f0-9-]{36}$/;
const WEBSITE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz"];
const DATABASE_EXTENSIONS = [".sql.gz", ".sql", ".tar.gz", ".tgz"];
const MAX_CHUNK_SIZE = 32 * 1024 * 1024;

function uploadId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!UPLOAD_ID_PATTERN.test(id)) {
    const error = new Error("Import upload ID is invalid");
    error.statusCode = 400;
    throw error;
  }
  return id;
}

function safeFilename(value) {
  const filename = path.basename(String(value || "").replaceAll("\\", "/"));
  if (!filename || filename === "." || filename.startsWith(".")) {
    const error = new Error("Upload filename is invalid");
    error.statusCode = 400;
    throw error;
  }
  return filename.slice(0, 240);
}

function extensionFor(filename, extensions) {
  const lower = filename.toLowerCase();
  return extensions.find((extension) => lower.endsWith(extension)) || "";
}

function parseContentRange(value) {
  if (!value) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(value).trim());
  if (!match) {
    const error = new Error("Upload Content-Range is invalid");
    error.statusCode = 400;
    throw error;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)
      || start < 0 || end < start || end >= total) {
    const error = new Error("Upload Content-Range is invalid");
    error.statusCode = 400;
    throw error;
  }
  return { start, end, total, size: end - start + 1 };
}

function validateArchiveEntry(raw) {
  const normalized = String(raw || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized && [".", "./"].includes(String(raw || ""))) return "";
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Archive contains an unsafe path: ${raw}`);
  }
  return normalized;
}

function walk(directory, visitor, depth = 0) {
  if (depth > 20) throw new Error("Archive directory nesting is too deep");
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Archive contains a symbolic link: ${entry.name}`);
    visitor(target, entry, stat);
    if (entry.isDirectory()) walk(target, visitor, depth + 1);
  }
}

class ByteLimit extends Transform {
  constructor(limit, label) {
    super();
    this.limit = limit;
    this.label = label;
    this.size = 0;
  }

  _transform(chunk, encoding, callback) {
    this.size += chunk.length;
    if (this.size > this.limit) {
      const error = new Error(`${this.label} exceeds the upload limit`);
      error.statusCode = 413;
      callback(error);
      return;
    }
    callback(null, chunk);
  }
}

class ProvisionImportStore {
  constructor(options = {}) {
    this.root = path.join(options.importsRoot || "/srv/imports", "ui-provision");
    this.websiteLimit = Number(options.websiteLimit || 8 * 1024 * 1024 * 1024);
    this.databaseLimit = Number(options.databaseLimit || 4 * 1024 * 1024 * 1024);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.removeExpired();
  }

  directory(id) {
    return path.join(this.root, uploadId(id));
  }

  metadataPath(id) {
    return path.join(this.directory(id), "uploads.json");
  }

  read(id) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metadataPath(id), "utf8"));
      return parsed && typeof parsed === "object" ? parsed : { files: {} };
    } catch {
      return { id: uploadId(id), files: {}, createdAt: new Date().toISOString() };
    }
  }

  write(id, metadata) {
    fs.writeFileSync(this.metadataPath(id), JSON.stringify(metadata, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  async upload(request, idValue, kind, filenameValue) {
    this.removeExpired();
    const id = uploadId(idValue);
    const filename = safeFilename(filenameValue);
    const definitions = {
      website: { extensions: WEBSITE_EXTENSIONS, limit: this.websiteLimit, stored: "website-upload" },
      database: { extensions: DATABASE_EXTENSIONS, limit: this.databaseLimit, stored: "database-upload" },
    };
    const definition = definitions[kind];
    if (!definition) {
      const error = new Error("Unknown import upload type");
      error.statusCode = 400;
      throw error;
    }
    const extension = extensionFor(filename, definition.extensions);
    if (!extension) {
      const error = new Error(`${kind === "website" ? "Website" : "Database"} file type is not supported`);
      error.statusCode = 400;
      throw error;
    }
    const declaredSize = Number(request.headers["content-length"] || 0);
    const range = parseContentRange(request.headers["content-range"]);
    if (range) {
      if (range.total > definition.limit) {
        const error = new Error(`${kind} upload exceeds the size limit`);
        error.statusCode = 413;
        request.resume();
        throw error;
      }
      if (range.size > MAX_CHUNK_SIZE || (declaredSize && declaredSize !== range.size)) {
        const error = new Error("Upload chunk size is invalid");
        error.statusCode = 400;
        request.resume();
        throw error;
      }
      return this.uploadChunk(request, id, kind, filename, extension, definition, range);
    }
    if (declaredSize > definition.limit) {
      const error = new Error(`${kind} upload exceeds the size limit`);
      error.statusCode = 413;
      request.resume();
      throw error;
    }
    const directory = this.directory(id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, `${definition.stored}${extension}`);
    const partial = `${destination}.partial`;
    fs.rmSync(partial, { force: true });
    const limiter = new ByteLimit(definition.limit, kind);
    try {
      await pipeline(request, limiter, fs.createWriteStream(partial, { mode: 0o600 }));
      if (!limiter.size) throw new Error(`${kind} upload is empty`);
      fs.renameSync(partial, destination);
      const metadata = this.read(id);
      metadata.id = id;
      metadata.updatedAt = new Date().toISOString();
      metadata.files[kind] = { filename, path: path.basename(destination), size: limiter.size };
      this.write(id, metadata);
      return { id, kind, filename, size: limiter.size };
    } catch (error) {
      fs.rmSync(partial, { force: true });
      throw error;
    }
  }

  async uploadChunk(request, id, kind, filename, extension, definition, range) {
    const directory = this.directory(id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, `${definition.stored}${extension}`);
    const partial = `${destination}.partial`;
    if (range.start === 0) {
      fs.rmSync(partial, { force: true });
      fs.rmSync(destination, { force: true });
    }
    const received = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    if (received === range.end + 1) {
      request.resume();
      return { id, kind, filename, size: range.total, received, complete: false, duplicate: true };
    }
    if (received !== range.start) {
      const error = new Error(`Upload offset mismatch; server has ${received} bytes`);
      error.statusCode = 409;
      request.resume();
      throw error;
    }

    const limiter = new ByteLimit(range.size, `${kind} chunk`);
    try {
      await pipeline(request, limiter, fs.createWriteStream(partial, { flags: "a", mode: 0o600 }));
      if (limiter.size !== range.size) throw new Error(`${kind} upload chunk is incomplete`);
    } catch (error) {
      if (fs.existsSync(partial)) fs.truncateSync(partial, range.start);
      throw error;
    }

    const complete = range.end + 1 === range.total;
    if (complete) {
      fs.renameSync(partial, destination);
      const metadata = this.read(id);
      metadata.id = id;
      metadata.updatedAt = new Date().toISOString();
      metadata.files[kind] = { filename, path: path.basename(destination), size: range.total };
      this.write(id, metadata);
    }
    return { id, kind, filename, size: range.total, received: range.end + 1, complete };
  }

  async archiveEntries(archive, label = "Website", options = {}) {
    const lower = archive.toLowerCase();
    const zipped = lower.endsWith(".zip");
    const command = zipped
      ? ["unzip", ["-Z1", archive]]
      : ["tar", [lower.endsWith(".tar") ? "-tf" : "-tzf", archive]];
    const { stdout } = await execFileAsync(command[0], command[1], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    const listedEntries = stdout.split(/\r?\n/).filter(Boolean);
    const normalizedEntries = listedEntries.map(validateArchiveEntry);
    const entries = normalizedEntries.filter(Boolean);
    const symlinks = [];
    if (!zipped) {
      const verbose = await execFileAsync("tar", [lower.endsWith(".tar") ? "-tvf" : "-tzvf", archive], {
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      const lines = verbose.stdout.split(/\r?\n/).filter(Boolean);
      if (lines.length !== listedEntries.length) throw new Error(`${label} archive listing is inconsistent`);
      const unsupported = lines.find((line, index) => {
        if (line[0] === "l" && normalizedEntries[index]) symlinks.push(normalizedEntries[index]);
        return !["-", "d", "l"].includes(line[0]);
      });
      if (unsupported) {
        throw new Error(`${label} archive may contain only regular files and directories`);
      }
      if (symlinks.length && !options.skipSymlinks) {
        throw new Error(`${label} archive contains ${symlinks.length} symbolic link${symlinks.length === 1 ? "" : "s"}`);
      }
    }
    return { entries, symlinks };
  }

  async extractArchive(archive, destination, excludedEntries = []) {
    const lower = archive.toLowerCase();
    if (lower.endsWith(".zip")) {
      await execFileAsync("unzip", ["-q", archive, "-d", destination], { timeout: 4 * 60 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
      return;
    }
    const exclusions = excludedEntries.flatMap((entry) => ["--exclude", entry]);
    await execFileAsync("tar", [lower.endsWith(".tar") ? "-xf" : "-xzf", archive, "-C", destination, ...exclusions], {
      timeout: 4 * 60 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  async prepare(idValue, websitePath) {
    this.removeExpired();
    const id = uploadId(idValue);
    const metadata = this.read(id);
    if (!metadata.files.website || !metadata.files.database) {
      const error = new Error("Upload both the website archive and database dump before importing");
      error.statusCode = 400;
      throw error;
    }
    const directory = this.directory(id);
    const archive = path.join(directory, metadata.files.website.path);
    const databaseDump = path.join(directory, metadata.files.database.path);
    if (!fs.existsSync(archive) || !fs.existsSync(databaseDump)) throw new Error("One or more staged import files are missing");
    const websiteManifest = await this.archiveEntries(archive, "Website", { skipSymlinks: true });

    const workspace = path.join(directory, "prepared");
    const extracted = path.join(workspace, "extracted");
    const normalized = path.join(workspace, "normalized", websitePath);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(extracted, { recursive: true, mode: 0o700 });
    await this.extractArchive(archive, extracted, websiteManifest.symlinks);

    const configs = [];
    walk(extracted, (target, entry) => {
      if (entry.isFile() && entry.name === "wp-config.php") configs.push(target);
    });
    if (configs.length !== 1) {
      throw new Error(`Website archive must contain exactly one wp-config.php (found ${configs.length})`);
    }
    const source = path.dirname(configs[0]);
    fs.mkdirSync(path.dirname(normalized), { recursive: true, mode: 0o700 });
    fs.renameSync(source, normalized);
    const normalizedArchive = path.join(workspace, "website.tar.gz");
    await execFileAsync("tar", ["-czf", normalizedArchive, "-C", path.join(workspace, "normalized"), websitePath], {
      timeout: 4 * 60 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });

    let databaseSource = databaseDump;
    if (databaseDump.toLowerCase().endsWith(".tar.gz") || databaseDump.toLowerCase().endsWith(".tgz")) {
      await this.archiveEntries(databaseDump, "Database");
      const databaseExtracted = path.join(workspace, "database-extracted");
      fs.mkdirSync(databaseExtracted, { recursive: true, mode: 0o700 });
      await this.extractArchive(databaseDump, databaseExtracted);
      const dumps = [];
      walk(databaseExtracted, (target, entry) => {
        if (entry.isFile() && (entry.name.toLowerCase().endsWith(".sql") || entry.name.toLowerCase().endsWith(".sql.gz"))) {
          dumps.push(target);
        }
      });
      if (dumps.length !== 1) {
        throw new Error(`Database archive must contain exactly one .sql or .sql.gz file (found ${dumps.length})`);
      }
      databaseSource = dumps[0];
    }

    const normalizedDatabase = path.join(workspace, "database.sql.gz");
    if (databaseSource.toLowerCase().endsWith(".sql.gz")) {
      fs.copyFileSync(databaseSource, normalizedDatabase);
    } else {
      await pipeline(fs.createReadStream(databaseSource), zlib.createGzip({ level: 6 }), fs.createWriteStream(normalizedDatabase, { mode: 0o600 }));
    }
    return {
      sourceDirectory: workspace,
      websiteArchive: path.basename(normalizedArchive),
      databaseDump: path.basename(normalizedDatabase),
    };
  }

  async installWebsiteArchive(idValue, destination) {
    this.removeExpired();
    const id = uploadId(idValue);
    const metadata = this.read(id);
    if (!metadata.files.website) {
      const error = new Error("Upload the website archive before importing");
      error.statusCode = 400;
      throw error;
    }
    const directory = this.directory(id);
    const archive = path.join(directory, metadata.files.website.path);
    if (!fs.existsSync(archive)) throw new Error("The staged website archive is missing");
    const websiteManifest = await this.archiveEntries(archive, "Website", { skipSymlinks: true });
    const workspace = path.join(directory, "static-prepared");
    const extracted = path.join(workspace, "extracted");
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(extracted, { recursive: true, mode: 0o700 });
    await this.extractArchive(archive, extracted, websiteManifest.symlinks);
    walk(extracted, () => {});

    const topLevel = fs.readdirSync(extracted, { withFileTypes: true });
    const source = topLevel.length === 1 && topLevel[0].isDirectory()
      ? path.join(extracted, topLevel[0].name)
      : extracted;
    const entries = fs.readdirSync(source, { withFileTypes: true });
    if (!entries.length) throw new Error("Website archive contains no files");
    for (const entry of entries) {
      fs.cpSync(path.join(source, entry.name), path.join(destination, entry.name), {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
    }
    return { fileCount: entries.length };
  }

  remove(id) {
    fs.rmSync(this.directory(id), { recursive: true, force: true });
  }

  removeExpired(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UPLOAD_ID_PATTERN.test(entry.name)) continue;
      const target = path.join(this.root, entry.name);
      if (fs.statSync(target).mtimeMs < cutoff) fs.rmSync(target, { recursive: true, force: true });
    }
  }
}

module.exports = {
  ProvisionImportStore,
  extensionFor,
  safeFilename,
  uploadId,
  validateArchiveEntry,
};
