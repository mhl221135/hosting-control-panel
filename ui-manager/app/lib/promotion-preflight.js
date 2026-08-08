const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const PREFLIGHT_TIMEOUT_MS = 90_000;

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

function requireSiteDatabase(siteType) {
  if (siteType === "wordpress" || siteType === "opencart") return "required";
  if (siteType === "generic-php") return "manifest";
  return "none";
}

// Reads the receiver state file written atomically by receive-backups.sh.
// Format: {version:1, lastRun, serverId, verifiedCount, sets:[{domain,setId,manifestSha256}]}
function readReceiverState(backupsRoot) {
  try {
    const filePath = path.join(backupsRoot, "receiver-state.json");
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Quick preflight: verifies manifests exist, artifacts present, no symlinks/traversal,
// and receiver receipts match. No streaming checksums (moved to deep-verify job).
async function runPreflight(opts = {}) {
  let timedOut = false;
  let timeoutHandle = null;
  let aborted = false;

  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      aborted = true;
      resolve({
        ready: false,
        checkedAt: new Date().toISOString(),
        checks: [{ status: "fail", reason: "Preflight timed out" }],
        summary: { total: 1, pass: 0, warning: 0, fail: 1 },
      });
    }, PREFLIGHT_TIMEOUT_MS);
  });

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
      dockerInfo = null,
      receiverState = null,
    } = opts;
    const freshnessMs = Number(maxBackupAgeHours) * 3_600_000;
    const checks = [];
    const SAFE_NAMES = new Set(["website.tar.gz", "database.sql.gz"]);

    if (aborted) return timeoutPromise;

    checks.push(check(isStandby ? "pass" : "fail",
      isStandby ? "Server is in standby role" : "Server is not in standby role"));

    // Machine marker
    const markerPath = opts.markerPath || "/run/hosting-machine/role.json";
    const markerOk = fs.existsSync(markerPath);
    checks.push(check(markerOk ? "pass" : isStandby ? "fail" : "warning",
      markerOk ? "Machine role marker is present" : isStandby ? "Machine role marker is missing" : "Machine role marker not on this platform"));

    // Metadata
    const roleFile = path.join(dataRoot, "server-role.json");
    const metaExists = fs.existsSync(roleFile);
    checks.push(check(metaExists ? "pass" : "warning", "Panel metadata"));

    // Receiver state
    const rcpt = receiverState || readReceiverState(backupsRoot);
    if (rcpt) {
      const age = Date.now() - Date.parse(rcpt.lastRun || "");
      checks.push(check(age < 7 * 24 * 3_600_000 ? "pass" : "warning",
        `Last receiver run: ${Math.round(age / 3_600_000)}h ago`));
      checks.push(check(rcpt.verifiedCount > 0 ? "pass" : "warning",
        `Receiver verified ${rcpt.verifiedCount || 0} sets`));
    } else if (isStandby) {
      checks.push(check("warning", "No receiver state found"));
    }

    // Backup inventory (quick: no streaming checksums)
    let newestAge = 0;
    let totalManifests = 0;
    const siteEntries = new Set(sites.map((s) => s.host));
    const foundSites = new Set();
    const siteIssues = new Map();
    for (const site of sites) siteIssues.set(site.host, []);

    if (fs.existsSync(backupsRoot)) {
      for (const entry of fs.readdirSync(backupsRoot, { withFileTypes: true })) {
        if (aborted) return timeoutPromise;
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
        if (!manifest) { siteIssues.get(entry.name).push("manifest missing or invalid"); continue; }
        if (setId !== manifest.id) siteIssues.get(entry.name).push("manifest.id mismatch");
        if (entry.name !== manifest.domain) siteIssues.get(entry.name).push("domain mismatch");

        // Check manifest hash against receiver receipt
        if (rcpt) {
          const receiptEntry = (rcpt.sets || []).find((s) => s.domain === entry.name && s.setId === setId);
          if (!receiptEntry) {
            siteIssues.get(entry.name).push("not in receiver receipt");
          } else {
            const manifestHash = require("crypto").createHash("sha256")
              .update(fs.readFileSync(manifestFile)).digest("hex");
            if (manifestHash !== receiptEntry.manifestSha256) {
              siteIssues.get(entry.name).push("manifest changed since receiver verification");
            }
          }
        }

        try {
          for (const f of fs.readdirSync(setDir, { withFileTypes: true })) {
            if (f.name === "manifest.json") continue;
            if (f.isSymbolicLink()) siteIssues.get(entry.name).push(`symlink: ${f.name}`);
            if (!SAFE_NAMES.has(f.name) && f.isFile()) siteIssues.get(entry.name).push(`unexpected file: ${f.name}`);
          }
        } catch {}

        const archivePath = path.join(setDir, "website.tar.gz");
        if (!fs.existsSync(archivePath)) siteIssues.get(entry.name).push("website archive missing");

        const dbArtifact = manifest.artifacts["database.sql.gz"];
        const dbPath = path.join(setDir, "database.sql.gz");
        const hasDb = fs.existsSync(dbPath) && dbArtifact;
        const siteType = sites.find((s) => s.host === entry.name)?.siteType || "wordpress";
        const dbReq = requireSiteDatabase(siteType);
        if (dbReq === "required" && !hasDb) siteIssues.get(entry.name).push("required database dump missing");
        if (dbReq === "manifest" && manifest.database !== null && !hasDb) siteIssues.get(entry.name).push("manifest records a database but dump missing");
        if (manifest.database === null && dbArtifact) siteIssues.get(entry.name).push("manifest has no db but artifact present");

        totalManifests += 1;
        foundSites.add(entry.name);
        const startedAt = Date.parse(manifest.startedAt);
        if (Number.isFinite(startedAt)) {
          const age = Date.now() - startedAt;
          if (age > newestAge) newestAge = age;
        }
      }
    }

    if (aborted) return timeoutPromise;
    if (totalManifests === 0) {
      checks.push(check("fail", "No valid version-2 site backup manifests were found"));
    } else {
      const ageH = Math.round(newestAge / 3_600_000);
      checks.push(check(newestAge > freshnessMs ? "warning" : "pass",
        `Latest backup age is ${ageH}h`));
    }

    for (const site of sites) {
      if (!foundSites.has(site.host)) {
        checks.push(check("fail", `${site.host}: no valid backup set`));
      } else {
        const issues = siteIssues.get(site.host) || [];
        checks.push(issues.length === 0
          ? check("pass", `${site.host}: receipt verified`)
          : check("fail", `${site.host}: ${issues.join("; ")}`));
      }
    }

    for (const [label, dir] of [["Backups", backupsRoot], ["Websites", websitesRoot], ["Sources", sourcesRoot]]) {
      checks.push(check(fs.existsSync(dir) ? "pass" : "fail", `${label} path exists`));
    }
    for (const [label, free] of [["Backup", diskFreeBytes(backupsRoot)], ["Target", diskFreeBytes(websitesRoot || path.resolve(path.join(backupsRoot, "..")))]]) {
      checks.push(check(free <= 0 ? "warning" : free >= 1_000_000_000 ? "pass" : "fail",
        `${label}: ${free > 0 ? (free / 1_000_000_000).toFixed(1) : "unknown"} GB free`));
    }

    for (const key of ["UI_SETTINGS_KEY", "BILLING_API_TOKEN", "SERVER_ID"]) {
      checks.push(check(Boolean(env[key]) ? "pass" : "warning", `${key} is ${env[key] ? "configured" : "not configured"}`));
    }

    if (aborted) return timeoutPromise;

    // Docker through hosting-agent or direct
    if (dockerInfo && typeof dockerInfo.check === "function") {
      const result = await dockerInfo.check();
      checks.push(check(result.ok ? "pass" : "fail", result.reason || "Docker check"));
    } else if (isStandby) {
      checks.push(check("warning", "Docker: not checked"));
    }

    // Ingress
    if (ingressMode === "cloudflare_tunnel") {
      const tokenOk = Boolean(process.env.CLOUDFLARED_TUNNEL_URL);
      checks.push(check(tokenOk ? "pass" : "fail", "Tunnel URL configured"));
    } else if (ingressMode === "direct_npm") {
      checks.push(check("pass", "Ingress: direct NPM"));
    } else {
      checks.push(check(isStandby ? "fail" : "warning", "Ingress mode not configured"));
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

  const result = timedOut ? timeoutPromise : await Promise.race([work, timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  return result;
}

module.exports = {
  DEFAULT_FRESHNESS_HOURS: 24,
  runPreflight,
  readSiteManifest,
  requireSiteDatabase,
};