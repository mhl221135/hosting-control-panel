const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { resolvePublicFile } = require("../lib/static-files");

test("resolves versioned public assets by URL pathname", () => {
  assert.equal(resolvePublicFile("/app/public", "/app.js?v=20260721-1"), "/app/public/app.js");
  assert.equal(resolvePublicFile("/app/public", "/"), "/app/public/index.html");
});

test("rejects public paths that escape the configured root", () => {
  assert.equal(resolvePublicFile("/app/public", "/..%2Fserver.js"), null);
  assert.equal(resolvePublicFile("/app/public", "/%E0%A4%A"), null);
});

test("standby role is machine-local, read-only, and suppresses writable services", () => {
  const compose = fs.readFileSync(path.resolve(__dirname, "../../../docker-compose.yml"), "utf8");
  const bootstrap = fs.readFileSync(path.resolve(__dirname, "../../../bootstrap.sh"), "utf8");
  const install = fs.readFileSync(path.resolve(__dirname, "../../../scripts/install.sh"), "utf8");
  const upgrade = fs.readFileSync(path.resolve(__dirname, "../../../scripts/upgrade.sh"), "utf8");
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  assert.match(compose, /HOSTING_MACHINE_STATE_DIR[^\n]*:\/run\/hosting-machine:ro/);
  assert.match(bootstrap, /--role/);
  assert.match(bootstrap, /--server-id/);
  assert.match(install, /Only hosting-agent and the read-only hosting-ui were started/);
  assert.match(upgrade, /compose stop hosting-files hosting-billing/);
  assert.match(server, /installationRole\.requireMutable\(\)/);
  assert.match(server, /if \(!installationRole\.isStandby\(\)\)/);
  assert.match(html, /id="installationRole"/);
  assert.match(source, /function applyInstallationRole/);
  assert.match(source, /new Set\(\["sites", "stats", "health", "jobs", "account"\]\)/);
});

test("backup restore UI exposes an explicit opt-in billing choice", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  assert.match(html, /id="restoreBackupDialog"/);
  assert.match(html, /name="register_billing"/);
  assert.match(html, /name="billing_grant_free_period"/);
  assert.match(source, /restoreBackupDialog.*showModal/s);
  assert.match(source, /JSON\.stringify\(formObject\(form\)\)/);
});

test("provisioning startup loads uploaded WordPress package choices", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  assert.match(html, /id="provisionPluginPackages"/);
  assert.match(html, /id="provisionThemePackages"/);
  assert.match(source, /api\("\/api\/wordpress-packages"\)/);
  assert.match(source, /state\.wordpressPackages = packages/);
  assert.match(source, /renderWordPressPackages\(\)/);
  assert.doesNotMatch(source, /#saveHosts|#hostsTable/);
});

test("PHP-FPM uses a directory bind so atomic pool replacements remain visible", () => {
  const compose = fs.readFileSync(path.resolve(__dirname, "../../../docker-compose.yml"), "utf8");
  const mainConfig = fs.readFileSync(path.resolve(__dirname, "../../../global-configs-new-upd/php-fpm/php-fpm.conf"), "utf8");
  const install = fs.readFileSync(path.resolve(__dirname, "../../../scripts/install.sh"), "utf8");
  const upgrade = fs.readFileSync(path.resolve(__dirname, "../../../scripts/upgrade.sh"), "utf8");
  assert.match(compose, /app-data\/configs\/php-fpm:\/runtime-php-fpm:ro/);
  assert.doesNotMatch(compose, /pools\.conf:\/usr\/local\/etc\/php-fpm\.d\/www\.conf/);
  assert.match(mainConfig, /include=\/runtime-php-fpm\/pools\.conf/);
  assert.match(install, /include=\/runtime-php-fpm\/pools\.conf/);
  assert.match(upgrade, /include=\/runtime-php-fpm\/pools\.conf/);
});

test("settings expose guarded billing enforcement controls", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  assert.match(html, /id="billingEnforcementSettingsForm"/);
  assert.match(html, /id="billingEnforcementHistory"/);
  assert.match(html, /Enable billing enforcement globally/);
  assert.match(html, /id="billingPilotSites"/);
  assert.match(html, /id="billingPilotSearch"/);
  assert.doesNotMatch(html, /name="pilotDomains"/);
  assert.match(html, /id="reconcileBillingEnforcement"/);
  assert.match(html, /id="disableBillingEnforcement"/);
  assert.match(source, /api\/billing\/enforcement\/reconcile/);
  assert.match(source, /api\/billing\/enforcement\/disable/);
  assert.match(source, /selectedBillingPilotDomains/);
});

test("runtime exposes an editable PHP-FPM profile form", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(html, /id="poolPresetsEditor"/);
  assert.match(html, /id="savePoolPresets"/);
  assert.match(source, /data-preset-field="max_children"/);
  assert.match(source, /method: "PUT"[\s\S]*\/api\/pool-presets/);
  assert.match(source, /data-preset-field="request_terminate_timeout"/);
  assert.match(source, /renderPoolCapacity/);
  assert.match(source, /PHP memory ceiling/);
  assert.match(source, /Custom \/ drifted/);
  assert.match(source, /Settings differ from every preset/);
  assert.match(source, /\/api\/pool-presets\/preview/);
  assert.match(html, /Preview impact/);
  assert.match(source, /Existing pools were not changed/);
  assert.match(source, /pool ports verified/);
  assert.match(server, /resolvePoolSectionName/);
  assert.match(html, /Apply to existing pools/);
  assert.match(source, /poolPresetApplyPreview\.tiers/);
  assert.match(source, /change\.field/);
  assert.match(source, /Preset values changed after preview/);
});

test("runtime exposes per-profile worker-memory estimates and a capacity summary", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(html, /id="poolCapacity"/);
  assert.match(html, /id="poolPresetsEditor"/);
  assert.match(source, /data-preset-field="estimated_memory_mb"/);
  assert.match(source, /Estimated memory per worker/);
  assert.match(source, /never written into PHP-FPM pool configuration/);
  assert.match(source, /state\.status\?\.capacity\?\.guardrails/);
  assert.match(source, /estimatedWorkerMemoryBytes/);
  assert.match(source, /ceilingBytes/);
  assert.match(source, /slotsPerCpu/);
  assert.match(source, /fallbackPoolCount/);
  assert.match(source, /fallbackMemoryMb/);
  assert.match(source, /estimatedRatio/);
  assert.match(server, /computeCapacitySummary/);
  assert.match(server, /capacityGuardrails/);
  assert.match(server, /estimated_memory_mb/);
  assert.match(server, /WORKER_MEMORY_MIN_MB/);
});

test("runtime exposes a PHP-FPM audit history section", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(html, /id="phpFpmAuditHistory"/);
  assert.match(html, /id="refreshPhpFpmAudit"/);
  assert.match(source, /api\/pool-presets\/audit/);
  assert.match(source, /function loadPhpFpmAudit/);
  assert.match(source, /function renderPhpFpmAudit/);
  assert.match(source, /escapeHtml\(event\.operator/);
  assert.match(source, /No PHP-FPM audit events recorded/);
  assert.match(source, /rollback/);
  assert.match(server, /phpFpmAudit\.record/);
  assert.match(server, /operation: "apply"/);
  assert.match(server, /requestUrl\.pathname === "\/api\/pool-presets\/audit"/);
  assert.match(server, /error\.executionStarted === true/);
  assert.match(server, /error\.rollbackStatus \|\| "not-required"/);
  assert.match(server, /throw error/);
});

test("all php pool mutations route through the shared runtime transaction", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(server, /require\("\.\/lib\/runtime-transaction"\)/);
  assert.match(server, /new RuntimeConfigTransaction/);
  assert.match(server, /runtimeTxn\.commit/);
  assert.match(server, /runtimeTxn\.rollback/);
  assert.match(server, /verifyPortsWithRetry/);
  assert.match(server, /allocatePort/);
  assert.match(server, /runtimeTxn\.lock\.runExclusive/);
  assert.doesNotMatch(server, /function writeConfigs/);
});

test("non-runtime settings mutations use guarded body parsing and atomic writes", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  const lib = fs.readFileSync(path.resolve(__dirname, "../lib/safe-write.js"), "utf8");
  assert.match(server, /guardSettingsBody\(await readJsonBody\(req\)/);
  const guardedCount = (server.match(/guardSettingsBody\(await readJsonBody\(req\)/g) || []).length;
  assert.ok(guardedCount >= 11, `expected >=11 guarded settings endpoints, got ${guardedCount}`);
  // key setting endpoints are present
  for (const path of ["/api/settings/performance", "/api/backups/settings", "/api/backups/offsite", "/api/settings/notifications", "/api/settings/integrations", "/api/billing/provisioning-settings", "/api/billing/observer/settings", "/api/billing/enforcement/settings", "/api/health/settings", "/api/cloudflare/automation", "/api/cloudflare/ip-addresses"]) {
    assert.ok(server.includes(`requestUrl.pathname === "${path}"`), path);
  }
  assert.match(lib, /function atomicWriteJson/);
  assert.match(lib, /renameSync\(temporary, filePath\)/);
});

test("runtime mutations use shared guarded validation", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(server, /require\("\.\/lib\/runtime-validation"\)/);
  assert.match(server, /async function readJsonBody/);
  assert.match(server, /guardBody\(parsed\)/);
  assert.match(server, /rejectUnknownKeys\(body, new Set\(\["name", "port", "tier", "settings"\]\)/);
  assert.match(server, /validHostname\(raw\.host\)/);
  assert.match(server, /documentRoot\(raw\.root\)/);
  assert.match(server, /validPort\(body\.port/);
});

test("runtime exposes a bounded runtime-configuration audit history", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(html, /id="runtimeConfigAuditHistory"/);
  assert.match(html, /id="refreshRuntimeConfigAudit"/);
  assert.match(html, /id="runtimeConfigAuditFilter"/);
  assert.match(source, /api\/runtime-config\/audit/);
  assert.match(source, /function renderRuntimeConfigAudit/);
  assert.match(source, /function loadRuntimeConfigAudit/);
  assert.match(source, /runtimeConfigAuditCountLabel/);
  assert.match(source, /escapeHtml\(event\.category\)/);
  assert.match(server, /requestUrl\.pathname === "\/api\/runtime-config\/audit"/);
  assert.match(server, /runtimeConfigAudit\.recent\(limit, category\)/);
  assert.match(server, /commitRuntimeConfig\(/);
});

test("runtime responsive contract: no hidden mobile overflow for preset editor and capacity", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../public/styles.css"), "utf8");
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  assert.match(css, /\.preset-editor \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  // mobile: preset editor collapses to a single column and button rows wrap
  assert.match(css, /@media \(max-width: 640px\) \{/);
  assert.match(css, /\.button-row \{ flex-wrap: wrap; \}/);
  assert.match(css, /\.button-row button \{ min-width: 0; \}/);
  // capacity grid collapses on small screens
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /\.pool-capacity \.capacity-grid \{ grid-template-columns: 1fr; \}/);
  // audit rows wrap long content
  assert.match(css, /\.php-fpm-audit-row p \{ margin: 0; color: var\(--muted\); overflow-wrap: anywhere; \}/);
  assert.match(html, /id="poolPresetsEditor"/);
  assert.match(html, /id="poolCapacity"/);
});

test("settings responsive contract: no mobile overflow and secret inputs masked", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../public/styles.css"), "utf8");
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(css, /@media \(max-width: 640px\) \{/);
  assert.match(css, /\.form-grid[\s\S]*\{ grid-template-columns: 1fr; \}/);
  assert.match(css, /button, input, select, textarea \{ min-height: 44px; \}/);
  // settings forms use responsive containers
  assert.match(html, /id="integrationSettingsForm" class="panel form-grid"/);
  assert.match(html, /id="notificationSettingsForm" class="panel form-grid"/);
  assert.match(html, /id="performanceSettingsForm" class="panel form-grid"/);
  assert.match(html, /id="backupSettingsForm" class="panel form-stack"/);
  assert.match(html, /id="offsiteSettingsForm" class="panel form-stack"/);
  // secrets are password inputs and never returned in public views
  assert.match(html, /name="npmSecret" type="password"/);
  assert.match(html, /name="cloudflareToken" type="password"/);
  assert.match(html, /name="telegramBotToken" type="password"/);
  assert.match(html, /name="smtpPassword" type="password"/);
  assert.match(html, /name="clear_access_key" type="checkbox"/);
  assert.match(html, /name="clear_secret_access_key" type="checkbox"/);
  assert.match(html, /name="clear_repository_password" type="checkbox"/);
  assert.match(server, /clearAccessKey: body\.clear_access_key/);
  assert.match(server, /clearSecretKey: body\.clear_secret_access_key/);
  assert.match(server, /clearRepositoryPassword: body\.clear_repository_password/);
  assert.match(server, /label: "DNS preset"/);
  assert.match(server, /nested: \{[\s\S]*php: \{ allowed:/);
});

test("manager-backed mutations use guarded parsing and the site-state transaction", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  const sst = fs.readFileSync(path.resolve(__dirname, "../lib/site-state-transaction.js"), "utf8");
  assert.match(server, /require\("\.\/lib\/site-state-transaction"\)/);
  assert.match(server, /applySiteStateTransaction\(\{/);
  assert.match(server, /requirePrimarySite\(mapParsed, domain/);
  for (const path of ["/api/site-state", "/api/site-state/purge", "/api/sites/images/settings", "/api/maintenance/settings", "/api/maintenance/updates/pins"]) {
    assert.ok(server.includes(`requestUrl.pathname === "${path}"`), path);
  }
  assert.ok((server.match(/guardSettingsBody\(await readJsonBody\(req\)/g) || []).length >= 16);
  assert.match(sst, /lock\.runExclusive\(async \(\) =>/);
  assert.match(sst, /atomicWriteJson\(siteStatePath/);
  assert.match(sst, /restore\(snap\)/);
  assert.match(sst, /renderCacheMapContent/);
});
