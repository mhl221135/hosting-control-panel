#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");

const BASE_URL = process.env.PANEL_SMOKE_URL || "http://127.0.0.1:8687";
const DOMAIN = "testsite.mishaweb.com";
const TERMINAL = new Set(["succeeded", "partially_succeeded", "failed", "cancelled"]);
let cookie = "";
let csrf = "";
let created = false;
let exportId = "";

function required(name) {
  const value = String(process.env[name] || "");
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function api(endpoint, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...(csrf && !["GET", "HEAD"].includes(options.method || "GET") ? { "X-CSRF-Token": csrf } : {}),
  };
  const response = await fetch(new URL(endpoint, BASE_URL), { ...options, headers: { ...headers, ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || "GET"} ${endpoint}: ${body.message || response.status}`);
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

async function waitJob(id, label, timeoutMs = 10 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { body } = await api(`/api/jobs/${encodeURIComponent(id)}`);
    if (TERMINAL.has(body.job.status)) {
      if (!["succeeded", "partially_succeeded"].includes(body.job.status)) {
        throw new Error(`${label} ${body.job.status}: ${body.job.error || body.job.message}`);
      }
      console.log(`${label}: ${body.job.status}`);
      return body.job;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out`);
}

function originStatus() {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "hosting-nginx",
      port: 80,
      path: "/",
      headers: { Host: DOMAIN },
      timeout: 10_000,
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("timeout", () => request.destroy(new Error("Origin request timed out")));
    request.on("error", reject);
  });
}

async function removeSite() {
  const { body: sites } = await api("/api/sites");
  if (!sites.sites.some((site) => site.host === DOMAIN && !site.isAlias)) return;
  const { body: preview } = await api(`/api/site-removal?domain=${encodeURIComponent(DOMAIN)}`);
  const resources = preview.plan.resources;
  const selection = {
    domain: DOMAIN,
    confirm_domain: DOMAIN,
    runtime: true,
    files: true,
    panel_state: true,
    backups: Boolean(resources.backups?.available && resources.backups?.safe),
  };
  const { body } = await api("/api/site-removal", {
    method: "POST",
    body: JSON.stringify(selection),
  });
  await waitJob(body.job.id, "cleanup");
  created = false;
}

async function removeExport() {
  if (!/^export-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(?:-\d{2})?$/.test(exportId)) return;
  const root = path.resolve(process.env.EXPORTS_ROOT || "/srv/exports");
  const target = path.resolve(root, exportId);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Export cleanup path escaped its root");
  fs.rmSync(target, { recursive: true, force: true });
  exportId = "";
}

async function main() {
  await login();
  const { body: initial } = await api("/api/sites");
  if (initial.sites.some((site) => site.host === DOMAIN)) {
    throw new Error(`${DOMAIN} already exists; refusing to modify it`);
  }
  const beforeExports = new Set((await api("/api/transfers/exports")).body.exports.map((item) => item.id));

  const { body: provision } = await api("/api/provision", {
    method: "POST",
    body: JSON.stringify({
      domain: DOMAIN,
      directory: DOMAIN,
      source_mode: "fresh",
      site_type: "static",
      add_www: false,
      create_npm_host: false,
      issue_ssl: false,
      create_update_dns: false,
      scheduled_backup: false,
      scheduled_image_optimization: false,
      opcache: false,
      redis: false,
      fastcgi_cache: false,
      notes: "Temporary UID 33 qualification site",
    }),
  });
  await waitJob(provision.job.id, "provision");
  created = true;
  const status = await originStatus();
  if (status !== 200) throw new Error(`Temporary site origin returned HTTP ${status}`);
  console.log("origin: 200");

  const { body: backup } = await api("/api/backups/site", {
    method: "POST",
    body: JSON.stringify({ domain: DOMAIN }),
  });
  await waitJob(backup.job.id, "backup");
  const backups = (await api(`/api/backups?name=${encodeURIComponent(DOMAIN)}`)).body.backups;
  if (!backups.length) throw new Error("Backup completed without a visible backup set");

  const { body: restore } = await api("/api/backups/restore", {
    method: "POST",
    body: JSON.stringify({ domain: DOMAIN, backup_id: backups[0].id }),
  });
  await waitJob(restore.job.id, "restore");
  if (await originStatus() !== 200) throw new Error("Restored temporary site origin is unhealthy");

  const { body: exported } = await api("/api/transfers/export", {
    method: "POST",
    body: JSON.stringify({ domains: [DOMAIN] }),
  });
  await waitJob(exported.job.id, "export");
  const exports = (await api("/api/transfers/exports")).body.exports;
  const artifact = exports.find((item) => !beforeExports.has(item.id));
  if (!artifact || !artifact.files?.some((file) => file.name.endsWith(".tar.gz"))) {
    throw new Error("Portable export artifact was not created");
  }
  exportId = artifact.id;

  await removeSite();
  await removeExport();
  const { body: finalSites } = await api("/api/sites");
  if (finalSites.sites.some((site) => site.host === DOMAIN)) throw new Error("Temporary site remained configured");
  console.log("cleanup: complete");
}

main().catch(async (error) => {
  console.error(error.message);
  try {
    if (created) await removeSite();
    await removeExport();
  } catch (cleanupError) {
    console.error(`cleanup failed: ${cleanupError.message}`);
  }
  process.exitCode = 1;
});
