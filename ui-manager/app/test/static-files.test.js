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

test("server exposes the bounded liveness endpoint used by standby promotion", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(server, /pathname === "\/health"/);
  assert.match(server, /sendJson\(res, 200, \{ ok: true, role: installationRole\.publicView\(\)\.role \}/);
  assert.match(server, /"Cache-Control": "no-store"/);
});

test("standby role is machine-local, read-only, and suppresses writable services", () => {
  const compose = fs.readFileSync(path.resolve(__dirname, "../../../docker-compose.yml"), "utf8");
  const bootstrap = fs.readFileSync(path.resolve(__dirname, "../../../bootstrap.sh"), "utf8");
  const install = fs.readFileSync(path.resolve(__dirname, "../../../scripts/install.sh"), "utf8");
  const upgrade = fs.readFileSync(path.resolve(__dirname, "../../../scripts/upgrade.sh"), "utf8");
  const prepare = fs.readFileSync(path.resolve(__dirname, "../../../scripts/prepare-standby.sh"), "utf8");
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  assert.match(compose, /HOSTING_MACHINE_STATE_DIR[^\n]*:\/run\/hosting-machine:ro/);
  assert.match(bootstrap, /--role/);
  assert.match(bootstrap, /--server-id/);
  assert.match(install, /Writable and public origin services remain stopped/);
  assert.match(install, /compose up -d hosting-agent hosting-ui hosting-cloudflared/);
  assert.match(compose, /hosting-cloudflared:[\s\S]*profiles:[\s\S]*- tunnel/);
  assert.match(compose, /hosting-cloudflared:[\s\S]*cap_drop:[\s\S]*- ALL/);
  assert.doesNotMatch(compose, /hosting-cloudflared:[\s\S]*\/var\/run\/docker\.sock/);
  assert.match(compose, /PHP_GLOBAL_INI_PATH/);
  assert.match(compose, /PHP_GLOBAL_INI_PATH[^\n]*:\/srv\/configs\/php\/global\.ini/);
  assert.match(compose, /MYSQL_SERVER_ID/);
  assert.match(compose, /MYSQL_INNODB_BUFFER_POOL_SIZE/);
  assert.match(compose, /REDIS_MAXMEMORY/);
  assert.match(compose, /STANDBY_PROFILE_NAME/);
  assert.match(compose, /image: phpmyadmin:5\.2\.2-apache/);
  assert.doesNotMatch(compose, /image: (?:arm64v8|amd64)\//);
  assert.match(server, /resourceProfile:/);
  assert.match(upgrade, /compose stop hosting-files hosting-billing/);
  assert.match(prepare, /--confirm PREPARE-STANDBY/);
  assert.match(prepare, /\.role == "standby"/);
  assert.match(prepare, /hosting-backup-receiver\/lock/);
  assert.match(prepare, /deep-verify-state\.json/);
  assert.match(prepare, /receiverReceiptSha256 == \$receiver_sha/);
  assert.match(prepare, /receiver_receipt_sha256/);
  assert.match(prepare, /deep_verification_sha256/);
  assert.match(prepare, /Writable hosting containers are running/);
  assert.match(prepare, /databases\.sql\.gz/);
  assert.match(prepare, /latest_site_set_at_or_before/);
  assert.match(prepare, /completed <= cutoff/);
  assert.match(prepare, /mysql -uroot -Nse \"SELECT 1\"/);
  assert.doesNotMatch(prepare, /mysqladmin[^\n]*ping/);
  assert.match(prepare, /SELECT COUNT\(\*\) FROM information_schema\.tables/);
  assert.doesNotMatch(prepare, /mysqlcheck/);
  assert.match(prepare, /compose create hosting-db hosting-redis hosting-php-fpm hosting-nginx/);
  assert.match(prepare, /rmdir "\$stage"[\s\S]+stage=""/);
  assert.doesNotMatch(prepare, /"role": "primary"/);
  assert.match(server, /installationRole\.requireMutable\(\)/);
  assert.match(server, /if \(!installationRole\.isStandby\(\)\)/);
  assert.match(html, /id="installationRole"/);
  assert.match(source, /function applyInstallationRole/);
  assert.match(source, /document\.title = role === "standby"/);
  assert.match(source, /new Set\(\["sites", "stats", "replication", "health", "jobs", "settings", "account"\]\)/);
  assert.match(html, /data-tab-link="replication"/);
  assert.match(html, /data-tab-panel="replication"/);
  assert.match(source, /switchTab\("replication"\)/);
  assert.match(html, /id="standbyIngressForm"/);
  assert.match(html, /id="runDeepVerify"/);
  assert.match(html, /id="preflightLastReceive"/);
  assert.match(html, /id="preflightReceiverState"/);
  assert.match(html, /id="preflightRecoveryAge"/);
  assert.match(source, /replication\.estimatedDataLossHours/);
  assert.match(source, /replication\.receiverCompletedSets/);
  assert.match(source, /receiverPercent/);
  assert.match(source, /api\("\/api\/system\/deep-verify"/);
  assert.match(server, /jobManager\.start\(\{ allowlist: new Set\(\["standby\.deep-verify"\]\), suppressDisallowed: true \}\)/);
  assert.match(server, /apiPath === "\/api\/system\/deep-verify"/);
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

test("OpenCart imports submit and accept the canonical database archive flag", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(source, /body\.import_database_archive = Boolean\(importing && \(genericPhp \|\| openCart\) && databaseDump\)/);
  assert.match(source, /wordpress \|\| body\.import_database_archive/);
  assert.doesNotMatch(source, /body\.import_database_dump =/);
  assert.match(server, /submitted\.import_database_archive === undefined && submitted\.import_database_dump !== undefined/);
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

test("standby promotion remains a fenced host-level operation", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../../../scripts/promote-standby.sh"), "utf8");
  assert.match(script, /--confirm PROMOTE-STANDBY/);
  assert.match(script, /--fence-confirm OLD-PRIMARY-FENCED/);
  assert.match(script, /--recovery-id/);
  assert.match(script, /receiverReceiptSha256/);
  assert.match(script, /deep_verification_sha256/);
  assert.match(script, /flock -n 9/);
  assert.match(script, /compose config --quiet/);
  assert.match(script, /docker exec hosting-php-fpm php-fpm -t/);
  assert.match(script, /docker exec hosting-nginx nginx -t/);
  assert.match(script, /mysql -uroot -Nse \"SELECT 1\"/);
  assert.doesNotMatch(script, /mysqladmin[^\n]*ping/);
  assert.match(script, /public_ingress_cutover:false/);
  assert.match(script, /chmod 644 "\$temporary"/);
  assert.match(script, /chmod 644 "\$promotion_tmp"/);
  assert.doesNotMatch(script, /cloudflare\.com|api\/zones|dns_records/);
});

test("read-only failover drills have a guarded standby reversion", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../../../scripts/revert-standby-drill.sh"), "utf8");
  assert.match(script, /--confirm REVERT-STANDBY-DRILL/);
  assert.match(script, /--writes-confirm NO-PUBLIC-WRITES/);
  assert.match(script, /public_ingress_cutover == false/);
  assert.match(script, /\.status == "rolled-back"/);
  assert.match(script, /flock -n 9/);
  assert.match(script, /compose stop hosting-npm/);
  assert.match(script, /role:"standby"/);
  assert.match(script, /chmod 644 "\$temporary"/);
  assert.match(script, /promotion-state\.last-drill\.json/);
  assert.match(script, /tunnel-cutover\.last-drill\.json/);
  assert.match(script, /rm -f "\$cutover_marker"/);
  assert.match(script, /systemctl enable --now hosting-backup-receiver\.timer/);
  assert.doesNotMatch(script, /cloudflare\.com|dns_records|api\/zones/);
});

test("standby activation composes promotion and allowlisted tunnel cutover", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../../../scripts/activate-standby.sh"), "utf8");
  assert.match(script, /--confirm ACTIVATE-STANDBY/);
  assert.match(script, /--fence-confirm OLD-PRIMARY-FENCED/);
  assert.match(script, /promote-standby\.sh" --dry-run/);
  assert.match(script, /tunnel-cutover\.sh" --preview/);
  assert.match(script, /promote-standby\.sh" --apply/);
  assert.match(script, /tunnel-cutover\.sh" --apply/);
  assert.match(script, /token_mode" = 600/);
  assert.match(script, /token_owner" = 0/);
  assert.match(script, /promote-standby\.sh" --apply[\s\S]+export CLOUDFLARE_TUNNEL_API_TOKEN/);
  assert.doesNotMatch(script, /OLD-PRIMARY-FENCED.*=.*true/);
});

test("NPM drops unmatched public requests while preserving HTTP-01 ACME", () => {
  const dockerfile = fs.readFileSync(path.resolve(__dirname, "../../../npm-custom/Dockerfile"), "utf8");
  const fallback = fs.readFileSync(path.resolve(__dirname, "../../../npm-custom/default.conf"), "utf8");
  assert.match(dockerfile, /COPY default\.conf \/etc\/nginx\/conf\.d\/default\.conf/);
  assert.match(fallback, /listen 80 default_server;/);
  assert.match(fallback, /listen 443 default_server ssl;/);
  assert.match(fallback, /include conf\.d\/include\/letsencrypt-acme-challenge\.conf;/);
  assert.match(fallback, /set \$forward_scheme "http";/);
  assert.match(fallback, /set \$server "127\.0\.0\.1";/);
  assert.match(fallback, /set \$port "80";/);
  assert.match(fallback, /location \/ \{[\s\S]+return 444;/);
  assert.match(fallback, /ssl_reject_handshake on;/);
  assert.doesNotMatch(fallback, /root \/var\/www\/html|index index\.html/);
});

test("deep backup verification has a standby-only operator CLI", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../cli/deep-verify.js"), "utf8");
  assert.match(source, /marker\?\.version === 1 && marker\?\.role === "standby"/);
  assert.match(source, /new DeepVerifyManager/);
  assert.match(source, /manager\.runDeepVerify/);
  assert.match(source, /Object\.assign\(progressState, progress\)/);
  assert.match(source, /atomicWriteJson\(progressPath/);
  assert.match(source, /writeProgress\("failed"/);
  assert.match(source, /cancellationRequested/);
  assert.doesNotMatch(source, /execSync|sh -c|Authorization|token|password/i);
});

test("successful standby reception schedules verification and fenced preparation", () => {
  const receiver = fs.readFileSync(path.resolve(__dirname, "../../../examples/systemd/hosting-backup-receiver.service"), "utf8");
  const verifier = fs.readFileSync(path.resolve(__dirname, "../../../examples/systemd/hosting-backup-deep-verify.service"), "utf8");
  const prepare = fs.readFileSync(path.resolve(__dirname, "../../../examples/systemd/hosting-standby-prepare.service"), "utf8");
  const timer = fs.readFileSync(path.resolve(__dirname, "../../../examples/systemd/hosting-backup-receiver.timer"), "utf8");
  assert.match(receiver, /^OnSuccess=hosting-backup-deep-verify\.service$/m);
  assert.match(verifier, /^OnSuccess=hosting-standby-prepare\.service$/m);
  assert.match(verifier, /^Type=oneshot$/m);
  assert.match(verifier, /^Nice=15$/m);
  assert.match(verifier, /flock -n \/run\/hosting-backup-receiver\/lock \/usr\/bin\/docker exec hosting-ui node \/app\/cli\/deep-verify\.js \/srv\/backups/);
  assert.doesNotMatch(verifier, /Environment|token|password|secret/i);
  assert.match(prepare, /^Type=oneshot$/m);
  assert.match(prepare, /^ExecStart=.*prepare-standby\.sh --apply --confirm PREPARE-STANDBY$/m);
  assert.match(prepare, /^TimeoutStartSec=12h$/m);
  assert.match(prepare, /^UMask=0077$/m);
  assert.match(prepare, /^ProtectSystem=strict$/m);
  assert.match(prepare, /^ReadWritePaths=\/media\/ssdmount\/websites-v2 \/etc\/hosting-control \/run\/hosting-backup-receiver$/m);
  assert.doesNotMatch(prepare, /Environment|token|password|secret/i);
  assert.match(timer, /^OnCalendar=\*-\*-\* 05:00:00 UTC$/m);
  assert.match(timer, /^RandomizedDelaySec=10m$/m);
});

test("local promotion keeps public-ingress status visible", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
  const source = fs.readFileSync(path.resolve(__dirname, "../public/app.js"), "utf8");
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(html, /id="promotionNotice"/);
  assert.match(source, /publicIngressCutover === false/);
  assert.match(source, /Public ingress has not been cut over/);
  assert.match(server, /readPromotionState/);
  assert.match(server, /promotion: readPromotionState/);
});

test("tunnel cutover isolates connector-secret decoding from management", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../../../scripts/tunnel-cutover.sh"), "utf8");
  assert.match(script, /--user 65532:65532/);
  assert.match(script, /decodeTunnelToken/);
  assert.match(script, /-e CLOUDFLARE_ACCOUNT_ID="\$account_id"/);
  assert.match(script, /-e CLOUDFLARED_TUNNEL_ID="\$tunnel_id"/);
  const management = script.slice(script.lastIndexOf("docker run --rm"));
  assert.doesNotMatch(management, /hosting-tunnel-token/);
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
