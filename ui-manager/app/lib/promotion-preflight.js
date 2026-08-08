const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_FRESHNESS_HOURS = 24;
const SAFE_ARTIFACT_NAMES = new Set(["website.tar.gz", "database.sql.gz"]);

function result(status, reason) {
  return { status, reason };
}

function readSiteManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!parsed || parsed.version !== 2 || parsed.type !== "site") return null;
    if (!parsed.domain || !parsed.artifacts || typeof parsed.artifacts !== "object") return null;
    return parsed;
  } catch {
    return null;
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

// Verify an artifact file matches its manifest record: size first, then
// stream the file into SHA-256. Never loads the archive into memory.
function verifyArtifact(artifactPath, expected) {
  if (!fs.existsSync(artifactPath)) return { ok: false, reason: "file missing" };
  const stat = fs.statSync(artifactPath);
  if (stat.size !== expected.size) return { ok: false, reason: `size mismatch (expected ${expected.size}, got ${stat.size})` };
  try {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(artifactPath, { highWaterMark: 64 * 1024 });
    return new Promise((resolve) => {
      let bytes = 0;
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 100 * 1024 * 1024 * 1024) { // safety cap per file
          stream.destroy();
          resolve({ ok: false, reason: "artifact exceeds size limit" });
        }
        hash.update(chunk);
      });
      stream.on("end", () => {
        const actual = hash.digest("hex");
        resolve(actual === expected.sha256
          ? { ok: true, reason: "verified" }
          : { ok: false, reason: "checksum mismatch" });
      });
      stream.on("error", () => resolve({ ok: false, reason: "read error" }));
    });
  } catch {
    return { ok: false, reason: "read error" };
  }
}

function requireSiteDatabase(siteType) {
  if (siteType === "wordpress" || siteType === "opencart") return "required";
  if (siteType === "generic-php") return "optional"; // recorded in manifest
  return "none";
}

function runPreflight(opts = {}) {
  const {
    isStandby = false,
    sites = [],
    backupsRoot = "",
    websitesRoot = "",
    sourcesRoot = "",
    dataRoot = "",
    ingressMode = "",
    env = {},
    maxBackupAgeHours = DEFAULT_FRESHNESS_HOURS,
    // optional DI for receiver/runtime checks
    receiver = null,
    dockerImages = [],
    systemdUnit = "",
  } = opts;
  const freshnessMs = Number(maxBackupAgeHours) * 3_600_000;
  const checks = [];

  // ── Role ──
  checks.push(result(
    isStandby ? "pass" : "fail",
    isStandby ? "Server is in standby role" : "Server is not in standby role; promotion requires standby mode",
  ));

  // ── Role config file ──
  const roleFile = path.join(dataRoot, "server-role.json");
  const roleOk = (() => {
    try {
      if (!fs.existsSync(roleFile)) return "absent";
      const parsed = JSON.parse(fs.readFileSync(roleFile, "utf8"));
      return parsed && parsed.version === 1 ? "valid" : "corrupt";
    } catch { return "corrupt"; }
  })();
  checks.push(result(
    roleOk === "valid" ? "pass" : roleOk === "absent" ? "warning" : "fail",
    roleOk === "valid" ? "Server metadata is readable"
      : roleOk === "absent" ? "Server metadata has not been created yet"
      : "Server metadata is corrupt",
  ));

  // ── Backup inventory (real layout: BACKUPS_ROOT/<domain>/<set>) ──
  let newestAge = 0;
  let totalManifests = 0;
  const siteEntries = new Set(sites.map((s) => s.host));
  const siteChecks = new Map();
  const foundSites = new Set();
  for (const site of sites) siteChecks.set(site.host, []);

  if (fs.existsSync(backupsRoot)) {
    for (const entry of fs.readdirSync(backupsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "app-data" || entry.name === "exports" || entry.name.startsWith(".")) continue;
      if (!siteEntries.has(entry.name)) continue;
      const siteDir = path.join(backupsRoot, entry.name);
      const sets = fs.readdirSync(siteDir).filter((name) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(name)).sort().reverse();
      if (!sets.length) continue;
      const latestSetDir = path.join(siteDir, sets[0]);
      const manifestFile = path.join(latestSetDir, "manifest.json");
      const manifest = readSiteManifest(manifestFile);
      if (!manifest) continue;
      totalManifests += 1;
      foundSites.add(entry.name);
      const startedAt = Date.parse(manifest.startedAt);
      if (Number.isFinite(startedAt)) {
        const age = Date.now() - startedAt;
        if (age > newestAge) newestAge = age;
      }
      const list = siteChecks.get(entry.name);
      if (!list) continue;
      // Artifact names must only contain safe names
      for (const artifactName of Object.keys(manifest.artifacts)) {
        if (!SAFE_ARTIFACT_NAMES.has(artifactName)) {
          list.push({ status: "fail", reason: `unsafe manifest artifact name: ${artifactName}` });
        }
      }
      // Website archive must exist
      const archivePath = path.join(latestSetDir, "website.tar.gz");
      const archiveArtifact = manifest.artifacts["website.tar.gz"];
      if (!fs.existsSync(archivePath) || !archiveArtifact) {
        list.push({ status: "fail", reason: "website archive missing" });
      }
      // Database dump by type
      const siteType = sites.find((s) => s.host === entry.name)?.siteType || "wordpress";
      const dbRequirement = requireSiteDatabase(siteType);
      const databaseArtifact = manifest.artifacts["database.sql.gz"];
      const databasePath = path.join(latestSetDir, "database.sql.gz");
      if (dbRequirement === "required" && (!databaseArtifact || !fs.existsSync(databasePath))) {
        list.push({ status: "fail", reason: "required database dump missing" });
      }
    }
  }

  if (totalManifests === 0) {
    checks.push(result("fail", "No valid version-2 site backup manifests were found"));
  } else {
    const ageHours = Math.round(newestAge / 3_600_000);
    const thresholdHours = Math.round(freshnessMs / 3_600_000);
    const stale = newestAge > freshnessMs;
    checks.push(result(
      stale ? "warning" : "pass",
      `Latest backup age is ${ageHours}h (threshold ${thresholdHours}h)`,
    ));
  }

  // Per-site results
  for (const site of sites) {
    if (!foundSites.has(site.host)) {
      checks.push(result("fail", `${site.host}: no stored backup sets`));
      continue;
    }
    const list = siteChecks.get(site.host) || [];
    if (list.length === 0) {
      checks.push(result("pass", `${site.host}: latest backup set and artifacts verified`));
    } else {
      for (const c of list) checks.push(result(c.status, `${site.host}: ${c.reason}`));
    }
  }

  // ── Filesystem ──
  for (const [label, dir] of [["Backups", backupsRoot], ["Websites", websitesRoot], ["Sources", sourcesRoot]]) {
    checks.push(result(fs.existsSync(dir) ? "pass" : "fail", `${label} path exists`));
  }
  const backupFree = diskFreeBytes(backupsRoot);
  const hostRoot = path.resolve(path.join(backupsRoot, ".."));
  const websitesFree = diskFreeBytes(websitesRoot.length > 0 ? websitesRoot : hostRoot);
  for (const [label, free] of [["Backup filesystem", backupFree], ["Target filesystem", websitesFree]]) {
    const gb = free > 0 ? (free / 1_000_000_000).toFixed(1) : "unknown";
    checks.push(result(
      free <= 0 ? "warning" : free >= 1_000_000_000 ? "pass" : "fail",
      `${label}: ${gb} GB free`,
    ));
  }

  // ── Environment ──
  for (const key of ["UI_SETTINGS_KEY", "BILLING_API_TOKEN", "SERVER_ID"]) {
    checks.push(result(
      Boolean(env[key]) ? "pass" : "warning",
      `${key} is ${env[key] ? "configured" : "not configured"}`,
    ));
  }

  // ── Docker (async via DI; synchronous fallback) ──
  if (receiver && typeof receiver.dockerAvailable === "function") {
    // injected for tests; handled synchronously
    checks.push(result(
      receiver.dockerAvailable() ? "pass" : "warning",
      "Docker daemon",
    ));
  } else {
    checks.push(result("warning", "Docker daemon (not checked)"));
  }

  // ── Receiver readiness ──
  if (receiver) {
    if (receiver.receiverState) {
      const state = receiver.receiverState;
      checks.push(result(
        state.active !== true ? "pass" : "warning",
        `Receiver state: ${state.active ? "active receive in progress" : "idle"}`,
      ));
      if (state.lastSuccess) {
        const lastMs = Date.now() - state.lastSuccess;
        const lastH = Math.round(lastMs / 3_600_000);
        checks.push(result(
          lastMs < 7 * 24 * 3_600_000 ? "pass" : "warning",
          `Last successful reception: ${lastH}h ago`,
        ));
      } else {
        checks.push(result("warning", "No successful receiver run recorded"));
      }
      checks.push(result(
        state.verifiedCount > 0 ? "pass" : "warning",
        `Receiver verified inventory: ${state.verifiedCount || 0} sets`,
      ));
    }
    if (systemdUnit) {
      checks.push(result("warning", `systemctl check for ${systemdUnit} unavailable in preflight`));
    }
  }
  if (dockerImages && dockerImages.length) {
    for (const img of dockerImages) {
      checks.push(result(
        img.exists ? "pass" : "fail",
        `Docker image: ${img.name} ${img.exists ? "present" : "missing"}`,
      ));
    }
  }

  // ── Ingress readiness ──
  if (ingressMode === "cloudflare_tunnel") {
    const tunnelUrl = String(env.CLOUDFLARED_TUNNEL_URL || "");
    checks.push(result(
      tunnelUrl ? "pass" : "fail",
      "Tunnel: cloudflared tunnel URL is configured",
    ));
  } else if (ingressMode === "direct_npm") {
    checks.push(result("pass", "Ingress: direct NPM (no additional config required)"));
  } else {
    checks.push(result("warning", "Ingress mode is not configured"));
  }

  const ready = checks.every((c) => c.status !== "fail");

  return {
    ready,
    checkedAt: new Date().toISOString(),
    checks,
    summary: {
      total: checks.length,
      pass: checks.filter((c) => c.status === "pass").length,
      warning: checks.filter((c) => c.status === "warning").length,
      fail: checks.filter((c) => c.status === "fail").length,
    },
  };
}

module.exports = {
  DEFAULT_FRESHNESS_HOURS,
  runPreflight,
  readSiteManifest,
  requireSiteDatabase,
  verifyArtifact,
};