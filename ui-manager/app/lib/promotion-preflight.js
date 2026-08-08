const fs = require("fs");
const path = require("path");

const DEFAULT_FRESHNESS_HOURS = 24;

function result(status, reason) {
  return { status, reason };
}

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.sites)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function diskFreeBytes(fsPath) {
  try {
    // Best-effort heuristic: try to stat each parent until we find one.
    let dir = path.resolve(fsPath);
    while (dir !== path.dirname(dir)) {
      try {
        const stat = fs.statfsSync(dir);
        if (stat && typeof stat.bfree === "bigint") return Number(stat.bfree * stat.bsize);
      } catch {}
      dir = path.dirname(dir);
    }
    return 0;
  } catch {
    return 0;
  }
}

function requireSiteAdapter(siteType) {
  const adapters = {
    wordpress: { database: "required" },
    opencart: { database: "required" },
    "generic-php": { database: "optional" },
    static: { database: "none" },
  };
  return adapters[siteType] || { database: "none" };
}

// Non-mutating promotion readiness preflight. Only reads filesystem; never writes.
function runPreflight(opts = {}) {
  const sites = Array.isArray(opts.sites) ? opts.sites : [];
  const backupsRoot = opts.backupsRoot || "";
  const websitesRoot = opts.websitesRoot || "";
  const sourcesRoot = opts.sourcesRoot || "";
  const dataRoot = opts.dataRoot || "";
  const env = opts.env || {};
  const freshnessMs = Number(opts.maxBackupAgeHours || DEFAULT_FRESHNESS_HOURS) * 3_600_000;
  const tunnelUrl = opts.tunnelUrl || "";

  const checks = [];

  // Role must be standby.
  checks.push(result(
    opts.isStandby === true ? "pass" : "fail",
    opts.isStandby ? "Server is in standby role" : "Server is not in standby role; promotion requires standby mode",
  ));

  // Role config present (warning if absent; only created on first use).
  const roleFile = path.join(dataRoot, "server-role.json");
  const roleOk = (() => {
    try {
      if (!fs.existsSync(roleFile)) return "absent";
      const parsed = JSON.parse(fs.readFileSync(roleFile, "utf8"));
      return parsed && parsed.version === 1 && parsed.role ? "valid" : "corrupt";
    } catch {
      return "corrupt";
    }
  })();
  checks.push(result(
    roleOk === "valid" ? "pass" : roleOk === "absent" ? "warning" : "fail",
    roleOk === "valid" ? "Server role configuration is readable"
      : roleOk === "absent" ? "Server role configuration has not been created yet"
      : "Server role configuration is corrupt",
  ));

  // Backup inventory exists.
  const backupDir = path.join(backupsRoot, "sites");
  const hasBackups = fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0;
  checks.push(result(hasBackups ? "pass" : "fail", "Verified backup inventory exists"));

  let newestAge = 0;
  let totalManifests = 0;
  if (hasBackups) {
    for (const siteName of fs.readdirSync(backupDir)) {
      const siteDir = path.join(backupDir, siteName);
      if (!fs.statSync(siteDir).isDirectory()) continue;
      const sets = fs.readdirSync(siteDir).sort().reverse();
      if (!sets.length) continue;
      const latestSetDir = path.join(siteDir, sets[0]);
      const manifestFile = path.join(latestSetDir, "manifest.json");
      const manifest = readManifest(manifestFile);
      if (!manifest) continue;
      totalManifests += 1;
      const createdAt = Date.parse(manifest.createdAt);
      if (Number.isFinite(createdAt)) {
        const age = Date.now() - createdAt;
        if (age > newestAge) newestAge = age;
      }
    }
    if (totalManifests === 0) {
      checks.push(result("fail", "No valid version-2 backup manifests were found"));
    } else {
      const ageHours = Math.round(newestAge / 3_600_000);
      const thresholdHours = Math.round(freshnessMs / 3_600_000);
      checks.push(result(
        newestAge <= freshnessMs ? "pass" : "warning",
        `Latest backup age is ${ageHours}h (threshold ${thresholdHours}h)`,
      ));
    }
  }

  // Site-by-site backup coverage.
  for (const site of sites) {
    const siteAdapter = requireSiteAdapter(site.siteType);
    const siteDir = path.join(backupsRoot, "sites", site.host);
    if (!fs.existsSync(siteDir)) {
      checks.push(result("fail", `${site.host}: no stored backup sets`));
      continue;
    }
    const sets = fs.readdirSync(siteDir).sort().reverse();
    if (!sets.length) {
      checks.push(result("fail", `${site.host}: no stored backup sets`));
      continue;
    }
    const setDir = path.join(siteDir, sets[0]);
    const manifestFile = path.join(setDir, "manifest.json");
    const manifest = readManifest(manifestFile);
    if (!manifest) {
      checks.push(result("fail", `${site.host}: missing or invalid version-2 manifest`));
      continue;
    }
    // Website archive
    checks.push(result(
      fs.existsSync(path.join(setDir, "website.tar.gz")) ? "pass" : "fail",
      `${site.host}: website archive present`,
    ));
    // Database dump
    if (siteAdapter.database !== "none") {
      checks.push(result(
        fs.existsSync(path.join(setDir, "database.sql.gz")) ? "pass" : "fail",
        `${site.host}: database dump present`,
      ));
    }
  }

  // Source/config directories exist.
  checks.push(result(fs.existsSync(websitesRoot) ? "pass" : "fail", "Websites directory exists"));
  checks.push(result(fs.existsSync(sourcesRoot) ? "pass" : "fail", "Sources directory exists"));

  // Filesystem free space (unknown → warning, not a blocker).
  const hostRoot = path.resolve(path.join(backupsRoot, ".."));
  const free = diskFreeBytes(hostRoot);
  const freeGb = free > 0 ? (free / 1_000_000_000).toFixed(1) : "unknown";
  checks.push(result(
    free <= 0
      ? "warning"
      : free >= 1_000_000_000
        ? "pass"
        : "fail",
    `Hosting filesystem free space: ${freeGb} GB`,
  ));

  // Environment values (configured/not-configured only).
  for (const key of ["UI_SETTINGS_KEY", "BILLING_API_TOKEN", "SERVER_ID"]) {
    checks.push(result(
      Boolean(env[key]) ? "pass" : "warning",
      `Environment: ${key} is ${env[key] ? "configured" : "not configured"}`,
    ));
  }

  // Docker availability (read-only check; non-fatal if unreachable).
  try {
    const { execSync } = require("child_process");
    try {
      execSync("docker info --format '{{.ServerVersion}}'", { timeout: 5_000, stdio: "ignore" });
      checks.push(result("pass", "Docker is available"));
    } catch {
      checks.push(result("warning", "Docker is not reachable"));
    }
  } catch {
    checks.push(result("warning", "Docker is not reachable"));
  }

  // Cloudflare tunnel readiness.
  if (tunnelUrl) {
    checks.push(result("pass", "Cloudflare tunnel: configured"));
  } else {
    checks.push(result("pass", "Cloudflare tunnel: not configured (direct NPM ingress)"));
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

module.exports = { DEFAULT_FRESHNESS_HOURS, runPreflight };