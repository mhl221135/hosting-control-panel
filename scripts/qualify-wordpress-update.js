#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const BASE_URL = process.env.PANEL_SMOKE_URL || "http://127.0.0.1:8687";
const DOMAIN = "testsite.mishaweb.com";
const DIRECTORY = DOMAIN;
const MODE = process.argv[2] || "";
const MODES = new Set(["core-theme", "uploaded-package"]);
const TERMINAL = new Set(["succeeded", "partially_succeeded", "failed", "cancelled"]);
const websitesRoot = path.resolve(process.env.WEBSITES_ROOT || "/srv/websites");
const siteDirectory = path.resolve(websitesRoot, DIRECTORY);
const packageIds = [];
let cookie = "";
let csrf = "";
let created = false;
let report = {
  version: 1,
  mode: MODE,
  domain: DOMAIN,
  startedAt: new Date().toISOString(),
  steps: [],
};

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function seconds(started) {
  return Math.max(1, Math.round((Date.now() - started) / 1000));
}

function record(name, detail = {}) {
  report.steps.push({ name, at: new Date().toISOString(), ...detail });
  console.log(`${name}${detail.status ? `: ${detail.status}` : ""}`);
}

async function api(endpoint, options = {}) {
  const method = options.method || "GET";
  const binary = Buffer.isBuffer(options.body);
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": binary ? "application/zip" : "application/json" } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...(csrf && !["GET", "HEAD"].includes(method) ? { "X-CSRF-Token": csrf } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(new URL(endpoint, BASE_URL), { method, headers, body: options.body });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${endpoint}: ${body.message || response.status}`);
  return { body, response };
}

async function login() {
  const { body, response } = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: required("UI_ADMIN_EMAIL"),
      password: required("UI_ADMIN_PASSWORD"),
    }),
  });
  cookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  csrf = String(body.csrf || "");
  if (!cookie || !csrf) throw new Error("Panel login did not return a session and CSRF token");
}

async function job(id) {
  return (await api(`/api/jobs/${encodeURIComponent(id)}`)).body.job;
}

async function waitJob(id, label, expected = new Set(["succeeded"]), timeoutMs = 40 * 60 * 1000) {
  const started = Date.now();
  let lastStep = "";
  while (Date.now() - started < timeoutMs) {
    const current = await job(id);
    if (current.currentStep && current.currentStep !== lastStep) {
      lastStep = current.currentStep;
      console.log(`${label}: ${lastStep}`);
    }
    if (TERMINAL.has(current.status)) {
      if (!expected.has(current.status)) {
        throw new Error(`${label} ${current.status}: ${current.error || current.message}`);
      }
      record(label, { status: current.status, seconds: seconds(started), jobId: id });
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} timed out`);
}

async function notificationResult(id, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await job(id);
    if (current.notifications?.length) {
      const statuses = current.notifications.flatMap((delivery) =>
        Object.entries(delivery.channels || {}).map(([channel, value]) => ({
          channel,
          status: value.status,
          attempts: value.attempts,
        })));
      if (statuses.length && statuses.every((item) => !["queued", "sending"].includes(item.status))) return statuses;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return [];
}

function requestStatus(transport, options) {
  return new Promise((resolve, reject) => {
    const request = transport.request(options, (response) => {
      response.resume();
      response.on("end", () => resolve(Number(response.statusCode || 0)));
    });
    request.setTimeout(20_000, () => request.destroy(new Error("Health request timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function originStatus(pathname = "/") {
  return requestStatus(http, {
    hostname: "hosting-nginx",
    port: 80,
    path: pathname,
    headers: { Host: DOMAIN },
  });
}

async function publicStatus(pathname = "/", timeoutMs = 5 * 60 * 1000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await requestStatus(https, {
        hostname: DOMAIN,
        port: 443,
        servername: DOMAIN,
        path: pathname,
      });
      if (status >= 200 && status < 400) return status;
      lastError = `HTTP ${status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Public HTTPS did not become healthy: ${lastError}`);
}

async function wp(args, timeout = 30 * 60 * 1000) {
  const result = await execFileAsync("docker", [
    "exec", "-u", "33:33", "hosting-php-fpm",
    "wp", "--allow-root", ...args, `--path=/var/www/${DIRECTORY}`,
  ], { timeout, maxBuffer: 4 * 1024 * 1024 });
  return String(result.stdout || "").trim();
}

async function wpValue(args) {
  return (await wp([...args, "--quiet"])).split(/\r?\n/).filter(Boolean).at(-1) || "";
}

function pluginSource(version) {
  return `<?php
/**
 * Plugin Name: Hosting Qualification Plugin
 * Description: Temporary controlled-update qualification package.
 * Version: ${version}
 */
add_action('init', static function () {});
`;
}

async function pluginZip(version, invalid = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-update-drill-"));
  const directory = path.join(root, "hosting-qualification");
  const archive = path.join(root, `hosting-qualification-${version}.zip`);
  fs.mkdirSync(directory);
  if (invalid) {
    fs.writeFileSync(
      path.join(directory, "qualification.txt"),
      "Intentional invalid WordPress package used to verify automatic rollback.\n",
      "utf8",
    );
  } else {
    fs.writeFileSync(path.join(directory, "hosting-qualification.php"), pluginSource(version), "utf8");
  }
  await execFileAsync("zip", ["-qr", archive, "hosting-qualification"], { cwd: root });
  return { root, archive, content: fs.readFileSync(archive) };
}

async function uploadPlugin(version, invalid = false) {
  const generated = await pluginZip(version, invalid);
  try {
    const { body } = await api(`/api/wordpress-packages/plugins?filename=${encodeURIComponent(`hosting-qualification-${version}.zip`)}`, {
      method: "POST",
      body: generated.content,
    });
    packageIds.push(body.package.id);
    return body.package;
  } finally {
    fs.rmSync(generated.root, { recursive: true, force: true });
  }
}

async function deletePackages() {
  while (packageIds.length) {
    const id = packageIds.pop();
    await api(`/api/wordpress-packages/plugins/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }
}

async function provision(initialPluginId) {
  const { body } = await api("/api/provision", {
    method: "POST",
    body: JSON.stringify({
      domain: DOMAIN,
      directory: DIRECTORY,
      source_mode: "fresh",
      site_type: "wordpress",
      title: "WordPress Update Qualification",
      admin_email: "qualification@example.com",
      admin_user: "qualification_admin",
      pool_tier: "low",
      opcache: true,
      redis: false,
      fastcgi_cache: false,
      scheduled_backup: false,
      scheduled_image_optimization: false,
      enable_comments: false,
      keep_default_plugins: false,
      keep_default_themes: false,
      plugin_packages: [initialPluginId],
      theme_packages: [],
      create_update_dns: true,
      dns_ip: required("PANEL_SMOKE_WAN_IP"),
      apply_dns_preset: false,
      add_www: false,
      create_npm_host: true,
      issue_ssl: true,
      apply_security_preset: false,
      apply_security_defaults: false,
      notes: `Temporary ${MODE} controlled-update drill`,
    }),
  });
  created = true;
  return waitJob(body.job.id, "provision", new Set(["succeeded"]));
}

async function previewUpdate(selection) {
  return (await api("/api/maintenance/updates/preview", {
    method: "POST",
    body: JSON.stringify({
      domain: DOMAIN,
      core: Boolean(selection.core),
      plugins: selection.plugins || [],
      themes: selection.themes || [],
      plugin_package_ids: selection.pluginPackageIds || [],
      theme_package_ids: [],
    }),
  })).body.preview;
}

async function applyUpdate(selection, label, expected) {
  const preview = await previewUpdate(selection);
  const { body } = await api("/api/maintenance/updates/apply", {
    method: "POST",
    body: JSON.stringify({ confirm: "UPDATE", preview }),
  });
  const result = await waitJob(body.job.id, label, expected);
  const notifications = await notificationResult(body.job.id);
  record(`${label}-notifications`, {
    status: notifications.length ? notifications.map((item) => `${item.channel}:${item.status}`).join(",") : "not-enabled",
  });
  return result;
}

async function updateRecord() {
  const history = (await api("/api/maintenance/status")).body.updateHistory;
  return history.find((entry) => entry.domain === DOMAIN);
}

async function backupSize(backupId) {
  const backups = (await api(`/api/backups?name=${encodeURIComponent(DOMAIN)}`)).body.backups;
  return Number(backups.find((item) => item.id === backupId)?.size || 0);
}

function versionParts(value) {
  return String(value).split(".").map((item) => Number(item.replace(/\D.*$/, "")) || 0);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

async function previousCoreVersion(current) {
  const response = await fetch("https://api.wordpress.org/core/version-check/1.7/");
  if (!response.ok) throw new Error(`WordPress version API returned HTTP ${response.status}`);
  const offers = (await response.json()).offers || [];
  const previous = offers
    .map((item) => String(item.current || item.version || ""))
    .filter((version, index, values) => version && values.indexOf(version) === index && compareVersions(version, current) < 0)
    .sort(compareVersions)
    .at(-1);
  if (!previous) throw new Error(`No supported WordPress version below ${current} was reported`);
  return previous;
}

async function assertHealthy(label) {
  const front = await originStatus("/");
  const admin = await originStatus("/wp-admin/");
  const publicFront = await publicStatus("/");
  if (front < 200 || front >= 400 || admin < 200 || admin >= 400) {
    throw new Error(`${label} origin is unhealthy: front ${front}, admin ${admin}`);
  }
  record(label, { status: `origin=${front}/${admin},https=${publicFront}` });
}

async function drillCoreTheme() {
  const current = await wpValue(["core", "version", "--skip-plugins", "--skip-themes"]);
  const previous = await previousCoreVersion(current);
  await wp(["core", "update", `--version=${previous}`, "--force", "--skip-plugins", "--skip-themes"]);
  await wp(["theme", "install", "twentytwentyfour", "--version=1.3", "--force", "--skip-plugins", "--skip-themes"]);
  record("downgrade-fixture", { status: `core=${previous},theme=twentytwentyfour@1.3` });

  const success = await applyUpdate({
    core: true,
    themes: ["twentytwentyfour"],
  }, "core-theme-update", new Set(["succeeded"]));
  const successHistory = await updateRecord();
  record("core-theme-evidence", {
    status: `${successHistory.beforeCore}->${successHistory.afterCore}`,
    backupId: successHistory.backupId,
    backupBytes: await backupSize(successHistory.backupId),
    backupSeconds: successHistory.backupSeconds,
    updateSeconds: successHistory.updateSeconds,
    jobSeconds: seconds(Date.parse(success.startedAt)),
  });
  await assertHealthy("core-theme-health");

  const invalidPackage = await uploadPlugin("9.9.2-fail", true);
  const failed = await applyUpdate({
    pluginPackageIds: [invalidPackage.id],
  }, "forced-rollback", new Set(["failed"]));
  if (!/rollback complete/i.test(`${failed.error} ${failed.message}`)) {
    throw new Error("Forced failure did not report a complete rollback");
  }
  const rollbackHistory = await updateRecord();
  const restoredVersion = await wpValue(["plugin", "get", "hosting-qualification", "--field=version", "--skip-plugins", "--skip-themes"]);
  if (restoredVersion !== "1.0.0") throw new Error(`Rollback restored plugin version ${restoredVersion}, expected 1.0.0`);
  record("rollback-evidence", {
    status: rollbackHistory.rollback,
    backupId: rollbackHistory.backupId,
    backupBytes: await backupSize(rollbackHistory.backupId),
    backupSeconds: rollbackHistory.backupSeconds,
    updateSeconds: rollbackHistory.updateSeconds,
    rollbackSeconds: rollbackHistory.rollbackSeconds,
  });
  await assertHealthy("rollback-health");
}

async function drillUploadedPackage() {
  await wp(["plugin", "install", "akismet", "--version=5.3", "--force", "--activate", "--skip-plugins", "--skip-themes"]);
  const safePackage = await uploadPlugin("2.0.0", false);
  const success = await applyUpdate({
    plugins: ["akismet"],
    pluginPackageIds: [safePackage.id],
  }, "repository-uploaded-update", new Set(["succeeded"]));
  const pluginVersion = await wpValue(["plugin", "get", "hosting-qualification", "--field=version", "--skip-plugins", "--skip-themes"]);
  if (pluginVersion !== "2.0.0") throw new Error(`Uploaded package installed version ${pluginVersion}, expected 2.0.0`);
  const successHistory = await updateRecord();
  record("repository-uploaded-evidence", {
    status: "complete",
    backupId: successHistory.backupId,
    backupBytes: await backupSize(successHistory.backupId),
    backupSeconds: successHistory.backupSeconds,
    updateSeconds: successHistory.updateSeconds,
    jobSeconds: seconds(Date.parse(success.startedAt)),
  });
  await assertHealthy("repository-uploaded-health");

  const invalidPackage = await uploadPlugin("9.9.3-fail", true);
  const failed = await applyUpdate({
    pluginPackageIds: [invalidPackage.id],
  }, "forced-rollback", new Set(["failed"]));
  if (!/rollback complete/i.test(`${failed.error} ${failed.message}`)) {
    throw new Error("Forced failure did not report a complete rollback");
  }
  const rollbackHistory = await updateRecord();
  const restoredVersion = await wpValue(["plugin", "get", "hosting-qualification", "--field=version", "--skip-plugins", "--skip-themes"]);
  if (restoredVersion !== "2.0.0") throw new Error(`Rollback restored plugin version ${restoredVersion}, expected 2.0.0`);
  record("rollback-evidence", {
    status: rollbackHistory.rollback,
    backupId: rollbackHistory.backupId,
    backupBytes: await backupSize(rollbackHistory.backupId),
    backupSeconds: rollbackHistory.backupSeconds,
    updateSeconds: rollbackHistory.updateSeconds,
    rollbackSeconds: rollbackHistory.rollbackSeconds,
  });
  await assertHealthy("rollback-health");
}

async function removeSite() {
  const { body: sites } = await api("/api/sites");
  if (!sites.sites.some((site) => site.host === DOMAIN && !site.isAlias)) return;
  const { body: preview } = await api(`/api/site-removal?domain=${encodeURIComponent(DOMAIN)}`);
  const resources = preview.plan.resources;
  const fields = {
    cloudflare_dns: "cloudflareDns",
    npm_host: "npmHost",
    npm_certificate: "npmCertificate",
    runtime: "runtime",
    pool: "pool",
    panel_state: "panelState",
    database: "database",
    files: "files",
    backups: "backups",
  };
  const selection = { domain: DOMAIN, confirm_domain: DOMAIN };
  for (const [field, resource] of Object.entries(fields)) {
    selection[field] = Boolean(resources[resource]?.available && resources[resource]?.safe);
  }
  const { body } = await api("/api/site-removal", {
    method: "POST",
    body: JSON.stringify(selection),
  });
  await waitJob(body.job.id, "cleanup", new Set(["succeeded"]));
  created = false;
}

async function removeOrphanDirectory() {
  const { body: sites } = await api("/api/sites");
  if (sites.sites.some((site) => site.host === DOMAIN)) return;
  if (!siteDirectory.startsWith(`${websitesRoot}${path.sep}`)) throw new Error("Qualification path escaped website root");
  fs.rmSync(siteDirectory, { recursive: true, force: true });
  created = false;
}

async function verifyCleanup() {
  const [
    { body: sites },
    { body: hosts },
    { body: certificates },
    { body: records },
    { body: backups },
    { body: packages },
  ] = await Promise.all([
    api("/api/sites"),
    api("/api/npm/hosts"),
    api("/api/npm/certificates"),
    api(`/api/cloudflare/records?domain=${encodeURIComponent(DOMAIN)}`),
    api(`/api/backups?name=${encodeURIComponent(DOMAIN)}`),
    api("/api/wordpress-packages"),
  ]);
  const failures = [];
  if (sites.sites.some((site) => site.host === DOMAIN)) failures.push("panel site");
  if (fs.existsSync(siteDirectory)) failures.push("website directory");
  if (hosts.hosts.some((host) => (host.domain_names || []).includes(DOMAIN))) failures.push("NPM host");
  if (certificates.certificates.some((certificate) =>
    (certificate.domain_names || []).includes(DOMAIN))) failures.push("NPM certificate");
  if (records.records.some((record) => record.name === DOMAIN)) failures.push("Cloudflare DNS");
  if (backups.backups.length) failures.push("backup sets");
  if ([...(packages.plugins || []), ...(packages.themes || [])]
    .some((item) => item.name.startsWith("hosting-qualification-"))) {
    failures.push("package library entries");
  }
  if (failures.length) throw new Error(`Cleanup left: ${failures.join(", ")}`);
}

async function persistReport(status, error = "") {
  report.status = status;
  report.error = String(error || "").slice(0, 1000);
  report.finishedAt = new Date().toISOString();
  const directory = path.resolve(process.env.DATA_DIR || "/app/data", "qualification");
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, `wordpress-update-${MODE}-${report.finishedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(destination, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`report: ${destination}`);
}

async function main() {
  if (!MODES.has(MODE)) throw new Error("Usage: qualify-wordpress-update.js core-theme|uploaded-package");
  await login();
  const { body: initial } = await api("/api/sites");
  if (initial.sites.some((site) => site.host === DOMAIN)) throw new Error(`${DOMAIN} already exists`);
  if (fs.existsSync(siteDirectory)) throw new Error(`${siteDirectory} already exists`);

  const initialPlugin = await uploadPlugin("1.0.0", false);
  await provision(initialPlugin.id);
  await assertHealthy("provision-health");
  if (MODE === "core-theme") await drillCoreTheme();
  else await drillUploadedPackage();
  await removeSite();
  await deletePackages();
  await removeOrphanDirectory();
  await verifyCleanup();
  record("cleanup-verification", { status: "complete" });
  await persistReport("passed");
}

main().catch(async (error) => {
  console.error(error.message);
  const cleanup = [];
  if (cookie && created) cleanup.push(["site", removeSite]);
  if (cookie) cleanup.push(["packages", deletePackages]);
  cleanup.push(["directory", removeOrphanDirectory]);
  for (const [name, operation] of cleanup) {
    try {
      await operation();
    } catch (cleanupError) {
      console.error(`${name} cleanup failed: ${cleanupError.message}`);
    }
  }
  await persistReport("failed", error.message).catch(() => {});
  process.exitCode = 1;
});
