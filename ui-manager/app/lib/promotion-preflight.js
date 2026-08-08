const crypto = require("crypto");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const { verifyArtifactManifest } = require("./backup-manager");

const execFileAsync = promisify(execFile);
const VERIFY_TIMEOUT = 60_000;
const PREFLIGHT_TIMEOUT_MS = 120_000;
const SAFE_ARTIFACT_NAMES = new Set(["website.tar.gz", "database.sql.gz"]);

function check(status, reason) {
  return { status, reason };
}

function readSiteManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!parsed || parsed.version !== 2 || parsed.type !== "site") return null;
    if (!parsed.domain || !parsed.websitePath || !parsed.startedAt || !parsed.completedAt) return null;
    if (!parsed.artifacts || typeof parsed.artifacts !== "object" || Array.isArray(parsed.artifacts)) return null;
    for (const [name, record] of Object.entries(parsed.artifacts)) {
      if (typeof record !== "object" || record === null) return null;
      if (!Number.isSafeInteger(record.size) || record.size < 1) return null;
      if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function validateManifestSet(manifest, setId, siteHost) {
  const issues = [];
  if (manifest.id !== setId) issues.push("manifest.id does not match backup set directory name");
  if (manifest.domain !== siteHost) issues.push("manifest.domain does not match site directory");
  if (!/^[a-z0-9._-]+$/.test(manifest.websitePath || "")) issues.push("manifest.websitePath is unsafe");
  if (!isFinite(Date.parse(manifest.startedAt)) || !isFinite(Date.parse(manifest.completedAt))) {
    issues.push("manifest timestamps are invalid");
  }
  for (const name of Object.keys(manifest.artifacts)) {
    if (!SAFE_ARTIFACT_NAMES.has(name)) issues.push(`unsafe artifact name: ${name}`);
  }
  return issues;
}

function requireSiteDatabase(siteType) {
  if (siteType === "wordpress" || siteType === "opencart") return "required";
  if (siteType === "generic-php") return "manifest"; // depends on manifest.database
  return "none";
}

// Validate an actual gzip/tar archive: runs tar -tzf, rejects unsafe paths.
async function validateTar(filePath) {
  try {
    const { stdout } = await execFileAsync("tar", ["-tzf", filePath], {
      timeout: VERIFY_TIMEOUT, maxBuffer: 256 * 1024,
    });
    const entries = String(stdout).trim().split("\n").filter(Boolean);
    if (entries.length === 0) return { ok: false, reason: "archive is empty" };
    for (const entry of entries) {
      if (entry.startsWith("/") || entry.includes("..")) {
        return { ok: false, reason: `archive contains unsafe path: ${entry}` };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "website.tar.gz is not a valid gzip/tar archive" };
  }
}

// Validate gzip integrity.
async function validateGzip(filePath) {
  try {
    await execFileAsync("gzip", ["-t", filePath], { timeout: VERIFY_TIMEOUT });
    return { ok: true };
  } catch {
    return { ok: false, reason: "file is not valid gzip" };
  }
}

function diskFreeBytes(directory) {
  try {
    const stat = fs.statfsSync(path.resolve(directory));
    if (stat && typeof stat.bfree === "bigint") return Number(stat.bfree * stat.bsize);
    return 0;
  } catch {
    return 0;
  }
}

async function runPreflight(opts = {}) {
  const timer = setTimeout(() => {}, PREFLIGHT_TIMEOUT_MS);
  const race = new Promise((resolve) => setTimeout(() => {
    resolve({ ready: false, checkedAt: new Date().toISOString(), checks: [{ status: "fail", reason: "Preflight timed out" }], summary: { total: 1, pass: 0, warning: 0, fail: 1 } });
  }, PREFLIGHT_TIMEOUT_MS));

  const work = (async () => {
    const {
      isStandby = false,
      sites = [],
      backupsRoot = "",
      websitesRoot = "",
      sourcesRoot = "",
      dataRoot = "",
      ingressMode = "",
      env = {},
      maxBackupAgeHours = 24,
      receiver = null,
      docker = null,
      ingress = null,
    } = opts;
    const freshnessMs = Number(maxBackupAgeHours) * 3_600_000;
    const checks = [];

    checks.push(check(isStandby ? "pass" : "fail",
      isStandby ? "Server is in standby role" : "Server is not in standby role"));

    const roleFile = path.join(dataRoot, "server-role.json");
    const roleOk = (() => {
      try {
        if (!fs.existsSync(roleFile)) return "absent";
        return JSON.parse(fs.readFileSync(roleFile, "utf8"))?.version === 1 ? "valid" : "corrupt";
      } catch { return "corrupt"; }
    })();
    checks.push(check(
      roleOk === "valid" ? "pass" : roleOk === "absent" ? "warning" : "fail",
      roleOk === "valid" ? "Server metadata is readable" : roleOk === "absent" ? "Server metadata has not been created yet" : "Server metadata is corrupt",
    ));

    let newestAge = 0;
    let totalManifests = 0;
    const siteEntries = new Set(sites.map((s) => s.host));
    const foundSites = new Set();
    const siteIssues = new Map();
    for (const site of sites) siteIssues.set(site.host, []);

    if (fs.existsSync(backupsRoot)) {
      for (const entry of fs.readdirSync(backupsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "app-data" || entry.name === "exports" || entry.name.startsWith(".")) continue;
        if (!siteEntries.has(entry.name)) continue;
        const siteDir = path.join(backupsRoot, entry.name);
        const sets = fs.readdirSync(siteDir).filter((n) =>
          /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(n)).sort().reverse();
        if (!sets.length) continue;
        const setId = sets[0];
        const setDir = path.join(siteDir, setId);
        const manifestFile = path.join(setDir, "manifest.json");
        const manifest = readSiteManifest(manifestFile);
        if (!manifest) { siteIssues.get(entry.name).push("manifest is missing, corrupt, or invalid"); continue; }
        const manifestIssues = validateManifestSet(manifest, setId, entry.name);
        for (const m of manifestIssues) siteIssues.get(entry.name).push(m);

        // Check for unexpected files/symlinks
        try {
          for (const f of fs.readdirSync(setDir, { withFileTypes: true })) {
            if (f.name === "manifest.json") continue;
            if (f.isSymbolicLink()) { siteIssues.get(entry.name).push(`symlink detected: ${f.name}`); }
            if (!SAFE_ARTIFACT_NAMES.has(f.name) && f.isFile()) {
              siteIssues.get(entry.name).push(`unexpected file: ${f.name}`);
            }
          }
        } catch {}

        // Website archive
        const archivePath = path.join(setDir, "website.tar.gz");
        const archiveArtifact = manifest.artifacts["website.tar.gz"];
        if (!fs.existsSync(archivePath) || !archiveArtifact) {
          siteIssues.get(entry.name).push("website archive missing");
        }

        // Database checks
        const siteType = sites.find((s) => s.host === entry.name)?.siteType || "wordpress";
        const dbReq = requireSiteDatabase(siteType);
        const dbArtifact = manifest.artifacts["database.sql.gz"];
        const dbPath = path.join(setDir, "database.sql.gz");
        const hasDb = fs.existsSync(dbPath) && dbArtifact;
        if (dbReq === "required" && !hasDb) siteIssues.get(entry.name).push("required database dump missing");
        if (dbReq === "manifest" && manifest.database !== null && !hasDb) siteIssues.get(entry.name).push("manifest records a database but dump is missing");
        if (manifest.database === null && dbArtifact) siteIssues.get(entry.name).push("manifest has no database but a database dump record is present");

        // Archive validation and artifact verification only when pre-checks clean
        if (siteIssues.get(entry.name).length === 0) {
          if (await validateTar(archivePath).then((r) => !r.ok)) {
            siteIssues.get(entry.name).push("website.tar.gz is not a valid tar archive");
          }
          if (hasDb && await validateGzip(dbPath).then((r) => !r.ok)) {
            siteIssues.get(entry.name).push("database.sql.gz is not valid gzip");
          }
        }
        if (siteIssues.get(entry.name).length === 0) {
          const requiredFiles = ["website.tar.gz"];
          if (hasDb) requiredFiles.push("database.sql.gz");
          try {
            await verifyArtifactManifest(setDir, manifest, requiredFiles);
          } catch (error) {
            siteIssues.get(entry.name).push(`artifact verification failed: ${String(error.message).slice(0, 120)}`);
          }
        }

        totalManifests += 1;
        foundSites.add(entry.name);
        const startedAt = Date.parse(manifest.startedAt);
        if (Number.isFinite(startedAt)) {
          const age = Date.now() - startedAt;
          if (age > newestAge) newestAge = age;
        }
      }
    }

    if (totalManifests === 0) {
      checks.push(check("fail", "No valid version-2 site backup manifests were found"));
    } else {
      const ageH = Math.round(newestAge / 3_600_000);
      checks.push(check(newestAge > freshnessMs ? "warning" : "pass",
        `Latest backup age is ${ageH}h (threshold ${Math.round(freshnessMs / 3_600_000)}h)`));
    }

    for (const site of sites) {
      if (!foundSites.has(site.host)) {
        checks.push(check("fail", `${site.host}: no valid backup set`));
      } else {
        const issues = siteIssues.get(site.host) || [];
        checks.push(issues.length === 0
          ? check("pass", `${site.host}: backup verified`)
          : check("fail", `${site.host}: ${issues.join("; ")}`));
      }
    }

    for (const [label, dir] of [["Backups", backupsRoot], ["Websites", websitesRoot], ["Sources", sourcesRoot]]) {
      checks.push(check(fs.existsSync(dir) ? "pass" : "fail", `${label} path exists`));
    }
    const hostRoot = path.resolve(path.join(backupsRoot, ".."));
    for (const [label, free] of [["Backup filesystem", diskFreeBytes(backupsRoot)], ["Target filesystem", diskFreeBytes(websitesRoot || hostRoot)]]) {
      checks.push(check(free <= 0 ? "warning" : free >= 1_000_000_000 ? "pass" : "fail",
        `${label}: ${free > 0 ? (free / 1_000_000_000).toFixed(1) : "unknown"} GB free`));
    }

    for (const key of ["UI_SETTINGS_KEY", "BILLING_API_TOKEN", "SERVER_ID"]) {
      checks.push(check(Boolean(env[key]) ? "pass" : "warning", `${key} is ${env[key] ? "configured" : "not configured"}`));
    }

    // Receiver
    if (receiver) {
      try {
        const state = await receiver.receiverState();
        if (state.error && isStandby) checks.push(check("fail", `Receiver: ${state.error}`));
        else if (state.active) checks.push(check("warning", "Receiver: active receive in progress"));
        checks.push(check(state.verifiedCount > 0 ? "pass" : "warning", `Receiver: ${state.verifiedCount || 0} verified backup sets`));
        if (state.lastSuccess > 0) {
          const h = Math.round((Date.now() - state.lastSuccess) / 3_600_000);
          checks.push(check(h < 168 ? "pass" : "warning", `Last successful receive: ${h}h ago`));
        } else if (isStandby) {
          checks.push(check("warning", "No successful receive recorded"));
        }
        const hasLock = await receiver.hasActiveLock();
        if (hasLock && isStandby) checks.push(check("fail", "Receiver lock is held; another receive may be in progress"));
        const timer = await receiver.timerState();
        if (isStandby && !timer.enabled) checks.push(check("warning", "Receiver timer is disabled"));
      } catch (err) {
        checks.push(check(isStandby ? "fail" : "warning", `Receiver check failed: ${String(err.message).slice(0, 120)}`));
      }
    } else if (isStandby) {
      checks.push(check("warning", "Receiver state could not be queried"));
    }

    // Docker
    if (docker) {
      const daemonOk = await docker.daemonAvailable();
      checks.push(check(daemonOk ? "pass" : "fail", "Docker daemon"));
      if (daemonOk) {
        const images = await docker.imageCheck();
        for (const img of images) {
          checks.push(check(img.exists ? "pass" : "fail", `Docker image: ${img.name}`));
        }
      }
    } else if (isStandby) {
      checks.push(check("warning", "Docker daemon (not checked)"));
    }

    // Ingress
    if (ingress) {
      for (const c of ingress.checks()) checks.push(c);
    } else {
      checks.push(check("warning", "Ingress mode is not configured"));
    }

    return {
      ready: checks.every((c) => c.status !== "fail"),
      checkedAt: new Date().toISOString(),
      checks,
      summary: {
        total: checks.length,
        pass: checks.filter((c) => c.status === "pass").length,
        warning: checks.filter((c) => c.status === "warning").length,
        fail: checks.filter((c) => c.status === "fail").length,
      },
    };
  })();

  const result = await Promise.race([work, race]);
  clearTimeout(timer);
  return result;
}

module.exports = {
  DEFAULT_FRESHNESS_HOURS: 24,
  runPreflight,
  readSiteManifest,
  requireSiteDatabase,
  validateManifestSet,
  validateTar,
  validateGzip,
};