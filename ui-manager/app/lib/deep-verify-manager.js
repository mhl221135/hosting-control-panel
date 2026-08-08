const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { atomicWriteJson } = require("./safe-write");
const { JobCancelledError } = require("./job-manager");
const {
  validateAppDataManifest, validateReceiverReceipt, validateSiteManifest, receiverReceiptSha256,
} = require("./promotion-preflight");

const MAX_ARCHIVE_ENTRIES = 500_000;
const MAX_ENTRY_LENGTH = 4096;
const PROCESS_TIMEOUT_MS = 5 * 60_000;
const JOB_TIMEOUT_MS = 6 * 60 * 60_000;

function confinedPath(base, ...segments) {
  const root = path.resolve(base);
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Backup path escapes the configured root");
  return target;
}

function regularFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Backup artifact is not a regular file: ${path.basename(filePath)}`);
  return stat;
}

function checkpoint(context, deadline) {
  context.checkpoint();
  if (Date.now() > deadline) throw new Error("Deep verification exceeded its maximum duration");
}

async function hashFile(filePath, context, deadline) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) {
    checkpoint(context, deadline);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function safeArchivePath(entry, expectedRoot) {
  if (!entry || entry.length > MAX_ENTRY_LENGTH || entry.startsWith("/") || /[\x00-\x1f\x7f]/.test(entry)) return false;
  const normalized = entry.replace(/\/$/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "..")) return false;
  return !expectedRoot || normalized === expectedRoot || normalized.startsWith(`${expectedRoot}/`);
}

function normalizedArchivePath(entry) {
  const normalized = path.posix.normalize(String(entry || "").replace(/^\.\//, "").replace(/\/$/, ""));
  return normalized === "." ? "" : normalized;
}

function confinedLinkTarget(source, target) {
  if (!target || target.startsWith("/") || /[\x00-\x1f\x7f]/.test(target)) return "";
  const sourcePath = normalizedArchivePath(source);
  const resolved = normalizedArchivePath(path.posix.join(path.posix.dirname(sourcePath), target));
  if (!resolved || resolved === ".." || resolved.startsWith("../")) return "";
  return resolved;
}

function runArchiveCommand(command, args, context, deadline, onLine) {
  return new Promise((resolve, reject) => {
    const remaining = Math.max(1, Math.min(PROCESS_TIMEOUT_MS, deadline - Date.now()));
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    let count = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      if (error) reject(error); else resolve(count);
    };
    const consume = (line) => {
      if (!line) return;
      count += 1;
      if (count > MAX_ARCHIVE_ENTRIES) throw new Error("Archive contains too many entries");
      onLine(line);
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error(`${command} validation timed out`)); }, remaining);
    const cancelPoll = setInterval(() => {
      if (context.cancellationRequested()) { child.kill("SIGKILL"); finish(new JobCancelledError()); }
    }, 250);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      try {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop();
        for (const line of lines) consume(line.replace(/\r$/, ""));
      } catch (error) { child.kill("SIGKILL"); finish(error); }
    });
    child.once("error", finish);
    child.once("close", (code) => {
      if (settled) return;
      try { consume(stdoutBuffer.replace(/\r$/, "")); }
      catch (error) { finish(error); return; }
      if (code !== 0) finish(new Error(`${command} validation failed${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}`));
      else if (!count && command === "tar") finish(new Error("Archive is empty"));
      else finish();
    });
  });
}

async function verifyTar(filePath, expectedRoot, context, deadline, options = {}) {
  const entries = [];
  await runArchiveCommand("tar", ["-tzf", filePath], context, deadline, (entry) => {
    if (!safeArchivePath(entry, expectedRoot)) throw new Error("Archive contains an unsafe or out-of-root path");
    entries.push(entry);
  });
  const types = new Map();
  const links = [];
  let entryIndex = 0;
  await runArchiveCommand("tar", ["-tvzf", filePath], context, deadline, (entry) => {
    const archiveEntry = entries[entryIndex++];
    if (archiveEntry === undefined) throw new Error("Archive listing changed during verification");
    const type = entry[0];
    const normalized = normalizedArchivePath(archiveEntry);
    if (type === "-" || type === "d") {
      if (normalized) types.set(normalized, type);
      return;
    }
    if (type !== "l" || !options.allowConfinedSymlinks) throw new Error("Archive contains a link or special file");
    const marker = entry.lastIndexOf(" -> ");
    const target = marker === -1 ? "" : entry.slice(marker + 4);
    const resolved = confinedLinkTarget(archiveEntry, target);
    if (!normalized || !resolved) throw new Error("Archive contains an unsafe symlink");
    types.set(normalized, type);
    links.push({ source: normalized, target: resolved });
  });
  if (entryIndex !== entries.length) throw new Error("Archive listing changed during verification");
  for (const link of links) {
    if (types.get(link.target) !== "-") throw new Error("Archive symlink target is missing or is not a regular file");
  }
}

async function verifyGzip(filePath, context, deadline) {
  await runArchiveCommand("gzip", ["-t", filePath], context, deadline, () => {});
}

class DeepVerifyManager {
  constructor(options) {
    this.jobManager = options.jobManager;
    this.backupsRoot = options.backupsRoot;
    this.jobTimeoutMs = Number(options.jobTimeoutMs || JOB_TIMEOUT_MS);
    this.jobManager.register("standby.deep-verify", (context) => this.runDeepVerify(context));
  }

  async runDeepVerify(context) {
    const deadline = Date.now() + this.jobTimeoutMs;
    const receiptPath = confinedPath(this.backupsRoot, "receiver-state.json");
    regularFile(receiptPath);
    const receipt = validateReceiverReceipt(JSON.parse(fs.readFileSync(receiptPath, "utf8")));
    if (!receipt) throw new Error("Receiver receipt is invalid, unsuccessful, or empty");
    const receiptHash = receiverReceiptSha256(this.backupsRoot);
    context.update({ total: receipt.sets.length, completed: 0, currentStep: "Starting deep verification" });
    const verifiedSets = [];

    for (const entry of receipt.sets) {
      checkpoint(context, deadline);
      context.update({ currentStep: `Verifying ${entry.domain} (${entry.setId})` });
      const setDir = confinedPath(this.backupsRoot, entry.domain, entry.setId);
      if (!fs.statSync(setDir).isDirectory()) throw new Error(`Backup set is missing: ${entry.domain}/${entry.setId}`);
      const manifestPath = confinedPath(setDir, "manifest.json");
      regularFile(manifestPath);
      const actualManifestHash = await hashFile(manifestPath, context, deadline);
      if (actualManifestHash !== entry.manifestSha256) throw new Error(`Manifest changed after reception: ${entry.domain}/${entry.setId}`);
      const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const manifest = entry.domain === "app-data" ? validateAppDataManifest(raw) : validateSiteManifest(raw);
      if (!manifest || manifest.id !== entry.setId || (manifest.type === "site" && manifest.domain !== entry.domain)) throw new Error(`Manifest contract failed: ${entry.domain}/${entry.setId}`);

      for (const [name, meta] of Object.entries(manifest.artifacts)) {
        checkpoint(context, deadline);
        const artifactPath = confinedPath(setDir, name);
        const stat = regularFile(artifactPath);
        if (stat.size !== meta.size) throw new Error(`Artifact size mismatch: ${entry.domain}/${entry.setId}/${name}`);
        if (await hashFile(artifactPath, context, deadline) !== meta.sha256) throw new Error(`Artifact checksum mismatch: ${entry.domain}/${entry.setId}/${name}`);
      }

      if (manifest.type === "app-data") {
        await verifyTar(confinedPath(setDir, "app-data.tar.gz"), null, context, deadline, { allowConfinedSymlinks: true });
        await verifyGzip(confinedPath(setDir, "databases.sql.gz"), context, deadline);
      } else {
        await verifyTar(confinedPath(setDir, "website.tar.gz"), manifest.websitePath, context, deadline);
        if (manifest.database !== null) await verifyGzip(confinedPath(setDir, "database.sql.gz"), context, deadline);
      }
      verifiedSets.push({ domain: entry.domain, setId: entry.setId, manifestSha256: entry.manifestSha256 });
      context.update({ completed: verifiedSets.length });
    }

    atomicWriteJson(confinedPath(this.backupsRoot, "deep-verify-state.json"), {
      version: 1, completedAt: new Date().toISOString(), result: "success",
      verifiedCount: verifiedSets.length, receiverReceiptSha256: receiptHash, verifiedSets,
    }, 0o600);
    return { ok: true, completed: verifiedSets.length, total: receipt.sets.length, message: "Deep verification completed" };
  }
}

module.exports = {
  DeepVerifyManager, confinedLinkTarget, confinedPath, hashFile, normalizedArchivePath,
  safeArchivePath, verifyGzip, verifyTar,
};
