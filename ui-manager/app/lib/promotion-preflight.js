const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const DEFAULT_FRESHNESS_HOURS = 24;
const SET_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const RECEIPT_KEYS = new Set(["version", "completedAt", "result", "sourceServerId", "verifiedCount", "sets"]);
const RECEIPT_SET_KEYS = new Set(["domain", "setId", "manifestSha256"]);
const RECEIVER_PROGRESS_KEYS = new Set([
  "version", "status", "startedAt", "finishedAt", "sourceServerId",
  "totalSets", "completedSets", "totalBytes", "completedBytes",
  "currentSetBytes", "currentSetReceivedBytes", "currentGroup", "currentSetId",
]);
const DEEP_PROGRESS_KEYS = new Set([
  "version", "status", "startedAt", "finishedAt", "completed", "total", "currentStep", "error",
]);
const SITE_KEYS = new Set(["version", "type", "id", "domain", "websitePath", "database", "startedAt", "completedAt", "artifacts"]);
const APP_DATA_KEYS = new Set(["version", "type", "id", "excluded", "startedAt", "completedAt", "artifacts"]);
const ARTIFACT_KEYS = new Set(["size", "sha256"]);
const RECOVERY_KEYS = new Set([
  "version", "prepared_at", "app_data_id", "site_count", "source_release",
  "receiver_receipt_sha256", "deep_verification_sha256",
]);

function check(status, reason) {
  return { status, reason: String(reason).slice(0, 500) };
}

function exactKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function validDate(value) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function validDomain(value) {
  return typeof value === "string" && DOMAIN_PATTERN.test(value);
}

function validRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || value.startsWith("/") || CONTROL_CHARS.test(value)) return false;
  return !value.split(/[\\/]/).some((part) => part === ".." || part === "");
}

function validateArtifact(meta) {
  return exactKeys(meta, ARTIFACT_KEYS)
    && Number.isSafeInteger(meta.size) && meta.size >= 1
    && typeof meta.sha256 === "string" && HEX_SHA256.test(meta.sha256);
}

function validateArtifacts(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const names = Object.keys(value).sort();
  return names.length === expected.length
    && names.every((name, index) => name === [...expected].sort()[index] && validateArtifact(value[name]));
}

function validateReceiverReceipt(parsed) {
  if (!exactKeys(parsed, RECEIPT_KEYS) || parsed.version !== 1 || parsed.result !== "success") return null;
  if (!SERVER_ID_PATTERN.test(String(parsed.sourceServerId || "")) || !validDate(parsed.completedAt)) return null;
  if (!Number.isInteger(parsed.verifiedCount) || parsed.verifiedCount < 1 || parsed.verifiedCount > 5000) return null;
  if (!Array.isArray(parsed.sets) || parsed.sets.length !== parsed.verifiedCount) return null;
  const seen = new Set();
  for (const entry of parsed.sets) {
    if (!exactKeys(entry, RECEIPT_SET_KEYS)) return null;
    if (!(entry.domain === "app-data" || validDomain(entry.domain))) return null;
    if (!SET_ID_PATTERN.test(String(entry.setId || "")) || !HEX_SHA256.test(String(entry.manifestSha256 || ""))) return null;
    const key = `${entry.domain}/${entry.setId}`;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return parsed;
}

function validateSiteManifest(parsed) {
  if (!exactKeys(parsed, SITE_KEYS) || parsed.version !== 2 || parsed.type !== "site") return null;
  if (!SET_ID_PATTERN.test(String(parsed.id || "")) || !validDomain(parsed.domain) || !validRelativePath(parsed.websitePath)) return null;
  if (!(parsed.database === null || (typeof parsed.database === "string" && /^[A-Za-z0-9_$-]{1,64}$/.test(parsed.database)))) return null;
  if (!validDate(parsed.startedAt) || !validDate(parsed.completedAt) || Date.parse(parsed.completedAt) < Date.parse(parsed.startedAt)) return null;
  const expected = parsed.database === null ? ["website.tar.gz"] : ["database.sql.gz", "website.tar.gz"];
  return validateArtifacts(parsed.artifacts, expected) ? parsed : null;
}

function validateAppDataManifest(parsed) {
  if (!exactKeys(parsed, APP_DATA_KEYS) || parsed.version !== 2 || parsed.type !== "app-data") return null;
  if (!SET_ID_PATTERN.test(String(parsed.id || "")) || !Array.isArray(parsed.excluded) || parsed.excluded.length > 100) return null;
  if (!parsed.excluded.every((item) => typeof item === "string" && item.length <= 200 && !CONTROL_CHARS.test(item))) return null;
  if (!validDate(parsed.startedAt) || !validDate(parsed.completedAt) || Date.parse(parsed.completedAt) < Date.parse(parsed.startedAt)) return null;
  return validateArtifacts(parsed.artifacts, ["app-data.tar.gz", "databases.sql.gz"]) ? parsed : null;
}

function readJson(filePath, validator) {
  try {
    if (!fs.statSync(filePath).isFile() || fs.statSync(filePath).size > 2_000_000) return null;
    return validator(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function readSiteManifest(filePath) { return readJson(filePath, validateSiteManifest); }
function readReceiverState(root) { return readJson(path.join(root, "receiver-state.json"), validateReceiverReceipt); }

function validateReceiverProgress(value) {
  if (!exactKeys(value, RECEIVER_PROGRESS_KEYS) || value.version !== 1) return null;
  if (!["running", "succeeded", "failed"].includes(value.status) || !validDate(value.startedAt)) return null;
  if (value.finishedAt && !validDate(value.finishedAt)) return null;
  if (!SERVER_ID_PATTERN.test(String(value.sourceServerId || ""))) return null;
  if (!Number.isInteger(value.totalSets) || value.totalSets < 0 || value.totalSets > 5000) return null;
  if (!Number.isInteger(value.completedSets) || value.completedSets < 0 || value.completedSets > value.totalSets) return null;
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || value.totalBytes > 100_000_000_000_000) return null;
  if (!Number.isSafeInteger(value.completedBytes) || value.completedBytes < 0 || value.completedBytes > value.totalBytes) return null;
  if (!Number.isSafeInteger(value.currentSetBytes) || value.currentSetBytes < 0 || value.currentSetBytes > value.totalBytes) return null;
  if (!Number.isSafeInteger(value.currentSetReceivedBytes) || value.currentSetReceivedBytes < 0 || value.currentSetReceivedBytes > value.currentSetBytes) return null;
  if (!(value.currentGroup === "" || value.currentGroup === "app-data" || validDomain(value.currentGroup))) return null;
  if (!(value.currentSetId === "" || SET_ID_PATTERN.test(value.currentSetId))) return null;
  return value;
}

function readReceiverProgress(root) {
  return readJson(path.join(root, "receiver-progress.json"), validateReceiverProgress);
}

function validateDeepVerifyProgress(value) {
  if (!exactKeys(value, DEEP_PROGRESS_KEYS) || value.version !== 1) return null;
  if (!["running", "succeeded", "failed"].includes(value.status) || !validDate(value.startedAt)) return null;
  if (value.finishedAt && !validDate(value.finishedAt)) return null;
  if (!Number.isInteger(value.completed) || !Number.isInteger(value.total) || value.completed < 0 || value.total < 0 || value.total > 5000 || value.completed > value.total) return null;
  if (typeof value.currentStep !== "string" || value.currentStep.length > 200 || CONTROL_CHARS.test(value.currentStep)) return null;
  if (typeof value.error !== "string" || value.error.length > 300 || CONTROL_CHARS.test(value.error)) return null;
  return value;
}

function readDeepVerifyProgress(root) {
  return readJson(path.join(root, "deep-verify-progress.json"), validateDeepVerifyProgress);
}

function receiverReceiptSha256(root) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "receiver-state.json"))).digest("hex"); }
  catch { return ""; }
}

function readDeepVerifyState(root) {
  return readJson(path.join(root, "deep-verify-state.json"), (value) => {
    if (!exactKeys(value, new Set(["version", "completedAt", "result", "verifiedCount", "receiverReceiptSha256", "verifiedSets"]))) return null;
    if (value.version !== 1 || value.result !== "success" || !validDate(value.completedAt) || !HEX_SHA256.test(String(value.receiverReceiptSha256 || ""))) return null;
    if (!Number.isInteger(value.verifiedCount) || !Array.isArray(value.verifiedSets) || value.verifiedSets.length !== value.verifiedCount) return null;
    return value;
  });
}

function validateStandbyRecovery(value) {
  if (!exactKeys(value, RECOVERY_KEYS) || value.version !== 1 || !validDate(value.prepared_at)) return null;
  if (!SET_ID_PATTERN.test(String(value.app_data_id || ""))) return null;
  if (!Number.isInteger(value.site_count) || value.site_count < 0 || value.site_count > 5000) return null;
  if (typeof value.source_release !== "string" || !value.source_release || value.source_release.length > 128 || CONTROL_CHARS.test(value.source_release)) return null;
  if (!HEX_SHA256.test(String(value.receiver_receipt_sha256 || "")) || !HEX_SHA256.test(String(value.deep_verification_sha256 || ""))) return null;
  return value;
}

function readStandbyRecoveryState(markerPath) {
  return readJson(path.join(path.dirname(markerPath), "standby-recovery.json"), validateStandbyRecovery);
}

function fileSha256(filePath) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
  catch { return ""; }
}

function memoryMb(value) {
  const match = String(value || "").trim().match(/^(\d+)([kmg])(?:i?b)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const scale = { k: 1 / 1024, m: 1, g: 1024 }[match[2].toLowerCase()];
  const result = amount * scale;
  return Number.isFinite(result) && result > 0 ? result : null;
}

function iniInteger(filePath, key) {
  try {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = fs.readFileSync(filePath, "utf8").match(new RegExp(`^\\s*${escaped}\\s*=\\s*(\\d+)\\s*$`, "m"));
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

function resourceProfileChecks(profile = {}) {
  const checks = [];
  const name = String(profile.name || "");
  const serverId = Number(profile.mysqlServerId);
  const mysqlBufferMb = memoryMb(profile.mysqlBuffer);
  const mysqlRedoMb = memoryMb(profile.mysqlRedo);
  const mysqlConnections = Number(profile.mysqlConnections);
  const redisMb = memoryMb(profile.redisMaxMemory);
  const opcacheMb = iniInteger(profile.phpIniPath, "opcache.memory_consumption");
  checks.push(check(name === "standby-8gb" ? "pass" : "fail", `Standby resource profile: ${name || "not configured"}`));
  checks.push(check(Number.isInteger(serverId) && serverId >= 2 && serverId <= 4_294_967_295 ? "pass" : "fail", "Standby MySQL server ID is unique"));
  checks.push(check(mysqlBufferMb !== null && mysqlBufferMb >= 512 && mysqlBufferMb <= 2048 ? "pass" : "fail", `Standby MySQL buffer: ${mysqlBufferMb ?? "invalid"} MB`));
  checks.push(check(mysqlRedoMb !== null && mysqlRedoMb >= 256 && mysqlRedoMb <= 1024 ? "pass" : "fail", `Standby MySQL redo: ${mysqlRedoMb ?? "invalid"} MB`));
  checks.push(check(Number.isInteger(mysqlConnections) && mysqlConnections >= 25 && mysqlConnections <= 150 ? "pass" : "fail", `Standby MySQL connections: ${Number.isFinite(mysqlConnections) ? mysqlConnections : "invalid"}`));
  checks.push(check(redisMb !== null && redisMb >= 128 && redisMb <= 512 ? "pass" : "fail", `Standby Redis: ${redisMb ?? "invalid"} MB`));
  checks.push(check(Number.isInteger(opcacheMb) && opcacheMb >= 512 && opcacheMb <= 3072 ? "pass" : "fail", `Standby OPcache: ${opcacheMb ?? "invalid"} MB`));
  return { checks, name, mysqlBufferMb, mysqlRedoMb, mysqlConnections, redisMb, opcacheMb, serverId };
}

function diskFreeBytes(directory) {
  try {
    const stat = fs.statfsSync(path.resolve(directory));
    return Number(BigInt(stat.bavail) * BigInt(stat.bsize));
  } catch { return 0; }
}

function requireSiteDatabase(siteType) {
  if (siteType === "wordpress" || siteType === "opencart") return "required";
  if (siteType === "generic-php") return "manifest";
  return "none";
}

function appendContainerChecks(checks, containers, ingressMode) {
  for (const name of ["hosting-agent", "hosting-ui"]) {
    checks.push(check(String(containers.get(name) || "").toLowerCase().startsWith("up") ? "pass" : "fail", `Required container running: ${name}`));
  }
  for (const name of ["hosting-db", "hosting-redis", "hosting-php-fpm", "hosting-nginx"]) {
    checks.push(check(containers.has(name) ? "pass" : "fail", `Container configured: ${name}`));
  }
  if (ingressMode === "direct_npm") checks.push(check(containers.has("hosting-npm") ? "pass" : "fail", "NPM container configured"));
  if (ingressMode === "cloudflare_tunnel") {
    const status = String(containers.get("hosting-cloudflared") || "").toLowerCase();
    checks.push(check(status.startsWith("up") ? "pass" : "fail", "Cloudflare tunnel container running"));
    checks.push(check(status.includes("(healthy)") ? "pass" : "fail", "Cloudflare tunnel connector ready"));
  }
}

async function dockerChecks(checks, ingressMode, dockerInfo) {
  if (dockerInfo && typeof dockerInfo.check === "function") {
    const result = await dockerInfo.check();
    checks.push(check(result.ok ? "pass" : "fail", result.reason || "Docker check"));
    return;
  }
  try {
    const { stdout } = await execFileAsync("docker", ["ps", "-a", "--filter", "name=hosting-", "--format", "{{.Names}}\t{{.Status}}"], { timeout: 10_000, maxBuffer: 256_000 });
    const containers = new Map(stdout.trim().split("\n").filter(Boolean).map((line) => {
      const [name, ...rest] = line.split("\t");
      return [name, rest.join("\t")];
    }));
    appendContainerChecks(checks, containers, ingressMode);
  } catch (error) {
    checks.push(check("fail", `Docker check failed: ${error.code === "ETIMEDOUT" ? "timed out" : error.message}`));
  }
}

async function runPreflight(opts = {}) {
  const {
    isStandby = false, sites = [], backupsRoot = "", websitesRoot = "", sourcesRoot = "", dataRoot = "",
    ingressMode = "", env = {}, maxBackupAgeHours = DEFAULT_FRESHNESS_HOURS, dockerInfo = null,
    receiverState = undefined, markerPath = "/run/hosting-machine/role.json", resourceProfile = null,
  } = opts;
  const checks = [];
  const freshnessMs = Math.max(1, Number(maxBackupAgeHours) || DEFAULT_FRESHNESS_HOURS) * 3_600_000;
  checks.push(check(isStandby ? "pass" : "fail", isStandby ? "Server is in standby role" : "Server is not in standby role"));
  checks.push(check(fs.existsSync(markerPath) ? "pass" : isStandby ? "fail" : "warning", fs.existsSync(markerPath) ? "Machine role marker is present" : "Machine role marker is missing"));
  checks.push(check(fs.existsSync(path.join(dataRoot, "server-role.json")) ? "pass" : "warning", "Panel ingress metadata"));

  const receipt = receiverState === undefined ? readReceiverState(backupsRoot) : validateReceiverReceipt(receiverState);
  const receiverProgress = readReceiverProgress(backupsRoot);
  if (receiverProgress?.status === "running") checks.push(check("fail", "Backup receiver is active"));
  else if (receiverProgress?.status === "failed") checks.push(check("warning", "Last backup receiver run failed"));
  if (!receipt) checks.push(check(isStandby ? "fail" : "warning", "No valid successful receiver receipt found"));
  else {
    const age = Date.now() - Date.parse(receipt.completedAt);
    checks.push(check(age >= 0 && age <= freshnessMs ? "pass" : "fail", `Last receiver run: ${Number.isFinite(age) && age >= 0 ? Math.round(age / 3_600_000) : "invalid"}h ago`));
  }

  try {
    const incoming = fs.readdirSync(path.join(backupsRoot, ".incoming"));
    if (incoming.length) checks.push(check("fail", "Partial or active receiver content exists"));
  } catch {}

  const receiptHash = receiverState === undefined ? receiverReceiptSha256(backupsRoot) : crypto.createHash("sha256").update(JSON.stringify(receiverState)).digest("hex");
  const deep = readDeepVerifyState(backupsRoot);
  const deepProgress = readDeepVerifyProgress(backupsRoot);
  checks.push(check(deep && deep.receiverReceiptSha256 === receiptHash ? "pass" : "warning", deep ? "Deep verification receipt binding" : "No deep verification result found"));

  const receiptEntries = new Map((receipt?.sets || []).map((entry) => [`${entry.domain}/${entry.setId}`, entry]));
  let oldestAge = 0;
  let appDataSet = "";
  try { appDataSet = fs.readdirSync(path.join(backupsRoot, "app-data"), { withFileTypes: true }).filter((e) => e.isDirectory() && SET_ID_PATTERN.test(e.name)).map((e) => e.name).sort().at(-1) || ""; } catch {}
  const appDataDir = path.join(backupsRoot, "app-data", appDataSet);
  const appDataManifestPath = path.join(appDataDir, "manifest.json");
  const appDataManifest = appDataSet ? readJson(appDataManifestPath, validateAppDataManifest) : null;
  const appDataIssues = [];
  if (!appDataManifest || appDataManifest.id !== appDataSet) appDataIssues.push("no valid app-data backup set");
  else {
    const entry = receiptEntries.get(`app-data/${appDataSet}`);
    if (!entry) appDataIssues.push("not in receiver receipt");
    else if (crypto.createHash("sha256").update(fs.readFileSync(appDataManifestPath)).digest("hex") !== entry.manifestSha256) appDataIssues.push("manifest changed after reception");
    for (const [name, meta] of Object.entries(appDataManifest.artifacts)) {
      try {
        const stat = fs.lstatSync(path.join(appDataDir, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== meta.size) appDataIssues.push(`${name} missing or size mismatch`);
      } catch { appDataIssues.push(`${name} missing or size mismatch`); }
    }
    oldestAge = Math.max(oldestAge, Date.now() - Date.parse(appDataManifest.completedAt));
  }
  checks.push(check(appDataIssues.length ? "fail" : "pass", `app-data: ${appDataIssues.join("; ") || "receiver receipt verified"}`));

  for (const site of sites) {
    const group = String(site.host || "").toLowerCase();
    const issues = [];
    let latest = "";
    try { latest = fs.readdirSync(path.join(backupsRoot, group), { withFileTypes: true }).filter((e) => e.isDirectory() && SET_ID_PATTERN.test(e.name)).map((e) => e.name).sort().at(-1) || ""; } catch {}
    const setDir = path.join(backupsRoot, group, latest);
    const manifestPath = path.join(setDir, "manifest.json");
    const manifest = latest ? readSiteManifest(manifestPath) : null;
    if (!manifest) issues.push("no valid backup set");
    else {
      if (manifest.id !== latest || manifest.domain !== group) issues.push("manifest identity mismatch");
      const entry = receiptEntries.get(`${group}/${latest}`);
      if (!entry) issues.push("not in receiver receipt");
      else {
        const digest = crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");
        if (digest !== entry.manifestSha256) issues.push("manifest changed after reception");
      }
      for (const [name, meta] of Object.entries(manifest.artifacts)) {
        try {
          const stat = fs.lstatSync(path.join(setDir, name));
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== meta.size) issues.push(`${name} missing or size mismatch`);
        } catch { issues.push(`${name} missing or size mismatch`); }
      }
      const mode = requireSiteDatabase(site.siteType || "wordpress");
      if (mode === "required" && manifest.database === null) issues.push("required database dump missing");
      const age = Date.now() - Date.parse(manifest.completedAt);
      if (Number.isFinite(age)) oldestAge = Math.max(oldestAge, age);
    }
    checks.push(check(issues.length ? "fail" : "pass", `${group}: ${issues.join("; ") || "receiver receipt verified"}`));
  }
  if (!sites.length) checks.push(check("warning", "No configured websites found"));
  else checks.push(check(oldestAge <= freshnessMs ? "pass" : "fail", `Oldest selected recovery point age is ${Math.round(oldestAge / 3_600_000)}h`));

  const recovery = readStandbyRecoveryState(markerPath);
  if (isStandby) {
    const recoveryIssues = [];
    if (!recovery) recoveryIssues.push("no valid prepared recovery marker");
    else {
      if (recovery.app_data_id !== appDataSet) recoveryIssues.push("app-data recovery point changed");
      if (recovery.site_count !== sites.length) recoveryIssues.push("configured website count changed");
      if (recovery.receiver_receipt_sha256 !== receiptHash) recoveryIssues.push("receiver receipt changed");
      const deepHash = fileSha256(path.join(backupsRoot, "deep-verify-state.json"));
      if (!deepHash || recovery.deep_verification_sha256 !== deepHash) recoveryIssues.push("deep-verification result changed");
      let currentRelease = "";
      try { currentRelease = fs.readFileSync(path.join(sourcesRoot, ".source-release"), "utf8").trim(); } catch {}
      if (!currentRelease || recovery.source_release !== currentRelease) recoveryIssues.push("source release changed or is unavailable");
    }
    checks.push(check(recoveryIssues.length ? "fail" : "pass", `Prepared recovery: ${recoveryIssues.join("; ") || "current and receipt-bound"}`));
  }

  for (const [label, dir] of [["Backups", backupsRoot], ["Websites", websitesRoot], ["Sources", sourcesRoot]]) checks.push(check(fs.existsSync(dir) ? "pass" : "fail", `${label} path exists`));
  for (const [label, dir] of [["Backup", backupsRoot], ["Target", websitesRoot || backupsRoot]]) {
    const free = diskFreeBytes(dir);
    checks.push(check(!free ? "warning" : free >= 1_000_000_000 ? "pass" : "fail", `${label}: ${free ? (free / 1_000_000_000).toFixed(1) : "unknown"} GB free`));
  }
  for (const key of ["UI_SETTINGS_KEY", "BILLING_API_TOKEN", "SERVER_ID"]) checks.push(check(env[key] ? "pass" : "warning", `${key} is ${env[key] ? "configured" : "not configured"}`));
  const resource = isStandby ? resourceProfileChecks(resourceProfile || {}) : null;
  if (resource) checks.push(...resource.checks);
  if (isStandby) await dockerChecks(checks, ingressMode, dockerInfo);
  checks.push(check(["direct_npm", "cloudflare_tunnel"].includes(ingressMode) ? "pass" : isStandby ? "fail" : "warning", ingressMode ? `Ingress: ${ingressMode}` : "Ingress mode not configured"));

  return {
    ready: checks.every((item) => item.status !== "fail"),
    checkedAt: new Date().toISOString(), checks,
    summary: { total: checks.length, pass: checks.filter((c) => c.status === "pass").length, warning: checks.filter((c) => c.status === "warning").length, fail: checks.filter((c) => c.status === "fail").length },
    replication: {
      mode: "backup_receiver",
      sourceServerId: receipt?.sourceServerId || "",
      lastReceivedAt: receipt?.completedAt || "",
      verifiedSetCount: receipt?.verifiedCount || 0,
      websiteGroupCount: new Set((receipt?.sets || []).filter((entry) => entry.domain !== "app-data").map((entry) => entry.domain)).size,
      appDataSetId: appDataManifest?.id || "",
      recoveryPointAt: oldestAge > 0 ? new Date(Date.now() - oldestAge).toISOString() : "",
      estimatedDataLossHours: oldestAge > 0 ? Math.ceil(oldestAge / 3_600_000) : null,
      deepVerification: deepProgress?.status === "running" ? "running"
        : deepProgress?.status === "failed" && Date.parse(deepProgress.finishedAt) >= Date.parse(deep?.completedAt || 0) ? "failed"
          : deep ? (deep.receiverReceiptSha256 === receiptHash ? "current" : "stale") : "missing",
      deepVerifiedAt: deep?.completedAt || "",
      deepVerifyCompletedSets: deepProgress?.completed || 0,
      deepVerifyTotalSets: deepProgress?.total || 0,
      deepVerifyCurrentStep: deepProgress?.currentStep || "",
      preparedAt: recovery?.prepared_at || "",
      preparedSiteCount: recovery?.site_count ?? null,
      preparedSourceRelease: recovery?.source_release || "",
      receiverStatus: receiverProgress?.status || "unknown",
      receiverCompletedSets: receiverProgress?.completedSets || 0,
      receiverTotalSets: receiverProgress?.totalSets || 0,
      receiverCompletedBytes: receiverProgress?.completedBytes || 0,
      receiverTotalBytes: receiverProgress?.totalBytes || 0,
      receiverCurrentSetBytes: receiverProgress?.currentSetBytes || 0,
      receiverCurrentSetReceivedBytes: receiverProgress?.currentSetReceivedBytes || 0,
      receiverCurrentGroup: receiverProgress?.currentGroup || "",
    },
    resourceProfile: resource ? {
      name: resource.name, mysqlServerId: resource.serverId,
      mysqlBufferMb: resource.mysqlBufferMb, mysqlRedoMb: resource.mysqlRedoMb,
      mysqlConnections: resource.mysqlConnections, redisMb: resource.redisMb,
      opcacheMb: resource.opcacheMb,
    } : null,
  };
}

module.exports = {
  DEFAULT_FRESHNESS_HOURS, SET_ID_PATTERN, appendContainerChecks, runPreflight, readSiteManifest, readReceiverState,
  readDeepVerifyState, receiverReceiptSha256, requireSiteDatabase, validateReceiverReceipt,
  readReceiverProgress, readStandbyRecoveryState, validateReceiverProgress,
  readDeepVerifyProgress, validateDeepVerifyProgress,
  validateSiteManifest, validateAppDataManifest,
  resourceProfileChecks, validateStandbyRecovery, validDomain, validRelativePath,
};
