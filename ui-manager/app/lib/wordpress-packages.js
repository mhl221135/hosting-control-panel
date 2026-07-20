const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PACKAGE_KINDS = ["plugins", "themes"];

function packageError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

class WordPressPackageStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, "wordpress-packages");
    this.metadataPath = path.join(this.root, "packages.json");
    for (const kind of PACKAGE_KINDS) fs.mkdirSync(path.join(this.root, kind), { recursive: true });
  }

  validateKind(kind) {
    const value = String(kind || "").toLowerCase();
    if (!PACKAGE_KINDS.includes(value)) throw packageError("Package type must be plugins or themes");
    return value;
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metadataPath, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((item) => fs.existsSync(item.path)) : [];
    } catch {
      return [];
    }
  }

  write(packages) {
    fs.writeFileSync(this.metadataPath, JSON.stringify(packages, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  publicView() {
    const grouped = { plugins: [], themes: [] };
    for (const item of this.read()) {
      grouped[item.kind].push({
        id: item.id,
        kind: item.kind,
        name: item.name,
        size: item.size,
        uploadedAt: item.uploadedAt,
      });
    }
    for (const kind of PACKAGE_KINDS) grouped[kind].sort((left, right) => left.name.localeCompare(right.name));
    return grouped;
  }

  upload(kind, originalName, content) {
    const normalizedKind = this.validateKind(kind);
    const name = path.basename(String(originalName || "").trim());
    if (!name || name.length > 180 || !/\.zip$/i.test(name)) throw packageError("Upload a WordPress ZIP package");
    if (!Buffer.isBuffer(content) || content.length < 4 || content[0] !== 0x50 || content[1] !== 0x4b) {
      throw packageError("The uploaded file is not a valid ZIP package");
    }
    const id = crypto.randomUUID();
    const filePath = path.join(this.root, normalizedKind, `${id}.zip`);
    fs.writeFileSync(filePath, content, { mode: 0o600, flag: "wx" });
    const item = {
      id,
      kind: normalizedKind,
      name,
      size: content.length,
      path: filePath,
      uploadedAt: new Date().toISOString(),
    };
    const packages = this.read();
    packages.push(item);
    this.write(packages);
    return this.publicItem(item);
  }

  publicItem(item) {
    return { id: item.id, kind: item.kind, name: item.name, size: item.size, uploadedAt: item.uploadedAt };
  }

  delete(kind, id) {
    const normalizedKind = this.validateKind(kind);
    const packages = this.read();
    const item = packages.find((entry) => entry.id === id && entry.kind === normalizedKind);
    if (!item) throw packageError("WordPress package not found", 404);
    fs.rmSync(item.path, { force: true });
    this.write(packages.filter((entry) => entry.id !== item.id));
  }

  resolve(kind, ids) {
    const normalizedKind = this.validateKind(kind);
    const requested = [...new Set(Array.isArray(ids) ? ids.map(String) : [])];
    const available = new Map(this.read().filter((item) => item.kind === normalizedKind).map((item) => [item.id, item]));
    return requested.map((id) => {
      const item = available.get(id);
      if (!item) throw packageError(`Selected ${normalizedKind.slice(0, -1)} package is no longer available`, 409);
      return item;
    });
  }
}

module.exports = { PACKAGE_KINDS, WordPressPackageStore };
