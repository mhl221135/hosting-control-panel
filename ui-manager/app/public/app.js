const state = {
  csrf: "",
  user: "",
  status: null,
  sites: [],
  pools: [],
  tiers: {},
  npmHosts: [],
  selectedDomain: "",
  backupName: "app-data",
  backupSettings: null,
  backupStatus: null,
  dnsRecords: [],
  dnsPresets: [],
  dnsPresetDraft: [],
  cloudflareIps: [],
  securityRules: [],
  wordpressPackages: { plugins: [], themes: [] },
  performance: null,
  imageOptimization: null,
  maintenance: null,
  jobs: [],
  activeTab: "sites",
  stats: null,
  health: null,
  siteStats: null,
  ipinfo: {},
  removalPlan: null,
};

let imageOptimizationPollTimer = null;
let maintenancePollTimer = null;
let jobsPollTimer = null;
let provisionInFlight = false;
const PROVISION_UPLOAD_CHUNK_SIZE = 16 * 1024 * 1024;
const PROVISION_UPLOAD_RETRIES = 3;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function notice(message, kind = "success") {
  const box = $("#notice");
  box.textContent = message;
  box.className = `notice${kind === "warning" ? " warning" : ""}`;
  window.clearTimeout(notice.timer);
  notice.timer = window.setTimeout(() => box.classList.add("hidden"), 7000);
}

async function api(url, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && state.csrf) headers["X-CSRF-Token"] = state.csrf;
  const response = await fetch(url, { ...options, method, headers, credentials: "same-origin" });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (response.status === 401 && !url.startsWith("/api/auth/")) showLogin();
  if (!response.ok) {
    const error = new Error(data.message || `Request failed (${response.status})`);
    error.details = data.details || "";
    error.data = data;
    throw error;
  }
  return data;
}

function formObject(form) {
  const output = {};
  for (const element of form.elements) {
    if (!element.name) continue;
    if (element.type === "radio" && !element.checked) continue;
    output[element.name] = element.type === "checkbox" ? element.checked : element.value;
  }
  return output;
}

function syncProvisionDnsOptions() {
  const form = $("#provisionForm");
  const manageDns = form.elements.create_update_dns.checked;
  const usePreset = form.elements.apply_dns_preset.checked;
  form.elements.dns_ip.disabled = !manageDns;
  form.elements.dns_ip.required = manageDns;
  form.elements.dns_preset_id.disabled = !usePreset;
  form.elements.dns_preset_id.required = usePreset;
}

function syncProvisionSourceMode() {
  const form = $("#provisionForm");
  const importing = form.elements.source_mode.value === "import";
  const wordpress = form.elements.site_type.value === "wordpress";
  $$('[data-provision-fresh]').forEach((element) => element.classList.toggle("hidden", importing || !wordpress));
  $$('[data-provision-import]').forEach((element) => element.classList.toggle("hidden", !importing));
  $$('[data-provision-wordpress]:not([data-provision-fresh])').forEach((element) => element.classList.toggle("hidden", !wordpress));
  for (const name of ["admin_email", "admin_user"]) {
    form.elements[name].required = wordpress && !importing;
    form.elements[name].disabled = importing || !wordpress;
  }
  form.elements.admin_password.disabled = importing || !wordpress;
  form.elements.title.disabled = importing || !wordpress;
  form.elements.enable_comments.disabled = importing || !wordpress;
  form.elements.keep_default_plugins.disabled = importing || !wordpress;
  form.elements.keep_default_themes.disabled = importing || !wordpress;
  form.elements.redis.disabled = !wordpress;
  if (!wordpress) form.elements.redis.checked = false;
  $("#provisionWebsiteArchive").required = importing;
  $("#provisionDatabaseDump").required = importing && wordpress;
  $("#provisionDatabaseDump").disabled = !wordpress;
  $("#provisionSubmit").textContent = importing ? "Import website" : wordpress ? "Create WordPress website" : "Create HTML/PHP website";
}

function provisionUploadId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === "x" ? random : (random & 3) | 8).toString(16);
  });
}

function uploadProvisionChunk(file, uploadId, kind, start, end, progress) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({
      upload_id: uploadId,
      kind,
      filename: file.name,
      offset: String(start),
      total_size: String(file.size),
    });
    const request = new XMLHttpRequest();
    request.open("POST", `/api/provision/import-upload?${query}`);
    request.withCredentials = true;
    request.setRequestHeader("Content-Type", "application/octet-stream");
    if (state.csrf) request.setRequestHeader("X-CSRF-Token", state.csrf);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) progress(start + event.loaded, file.size);
    });
    request.addEventListener("load", () => {
      let response = {};
      try { response = request.responseText ? JSON.parse(request.responseText) : {}; } catch { response = {}; }
      if (request.status >= 200 && request.status < 300) resolve(response);
      else {
        const error = new Error(response.message || `Upload failed (${request.status})`);
        error.retryable = request.status >= 500 || request.status === 408 || request.status === 429;
        reject(error);
      }
    });
    request.addEventListener("error", () => {
      const error = new Error("Upload connection failed");
      error.retryable = true;
      reject(error);
    });
    request.addEventListener("abort", () => reject(new Error("Upload was cancelled")));
    request.send(file.slice(start, end));
  });
}

async function uploadProvisionImport(file, uploadId, kind, progress) {
  for (let start = 0; start < file.size; start += PROVISION_UPLOAD_CHUNK_SIZE) {
    const end = Math.min(start + PROVISION_UPLOAD_CHUNK_SIZE, file.size);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await uploadProvisionChunk(file, uploadId, kind, start, end, progress);
        progress(end, file.size);
        break;
      } catch (error) {
        if (!error.retryable || attempt >= PROVISION_UPLOAD_RETRIES) throw error;
        await new Promise((resolve) => window.setTimeout(resolve, 750 * (2 ** attempt)));
      }
    }
  }
}

function uploadProgress(label, loaded, total) {
  const percent = total ? Math.round((loaded / total) * 100) : 0;
  const loadedMb = (loaded / 1024 / 1024).toFixed(1);
  const totalMb = (total / 1024 / 1024).toFixed(1);
  return `${label}: ${percent}% (${loadedMb} MB / ${totalMb} MB)`;
}

async function withButton(button, pendingText, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = pendingText;
  try { return await work(); }
  finally { button.disabled = false; button.textContent = original; }
}

function showLogin() {
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
  state.csrf = "";
}

function showApp(session) {
  state.csrf = session.csrf;
  state.user = session.email;
  $("#currentUser").textContent = session.email;
  $("#accountEmail").value = session.email;
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  if (session.mustChangePassword) {
    switchTab("account");
    notice("Change the initial panel password before continuing.", "warning");
  }
}

function switchTab(name) {
  state.activeTab = name;
  $$("[data-tab-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.tabPanel !== name));
  $$("[data-tab-link]").forEach((button) => button.classList.toggle("active", button.dataset.tabLink === name));
  $("#mobileNavigation").value = name;
  const titles = { sites: "Sites", stats: "Stats", health: "Health", jobs: "Jobs", maintenance: "Maintenance", provision: "Provision", integrations: "DNS & SSL", security: "Security", backups: "Backups", removal: "Delete website", runtime: "Runtime", settings: "Settings", account: "Account" };
  $("#pageTitle").textContent = titles[name] || "Hosting Control";
  if (name === "integrations") refreshIntegrationView();
  if (name === "security") loadSecurity().catch((error) => notice(error.message, "warning"));
  if (name === "stats" && !state.stats) loadStats().catch((error) => notice(error.message, "warning"));
  if (name === "health") loadHealth().catch((error) => notice(error.message, "warning"));
  if (name === "jobs") loadJobs().catch((error) => notice(error.message, "warning"));
  if (name === "maintenance") loadMaintenance().catch((error) => notice(error.message, "warning"));
  if (name === "backups") loadBackupView().catch((error) => notice(error.message, "warning"));
  if (name === "removal") loadRemovalPlan().catch((error) => notice(error.message, "warning"));
  if (name === "runtime") loadLogs();
  if (name === "settings") loadIntegrationSettings();
}

function rememberJob(job, message = "Job queued") {
  if (!job) return;
  state.jobs = [job, ...state.jobs.filter((item) => item.id !== job.id)];
  notice(`${message}. Job ${job.id.slice(0, 8)}.`);
  if (state.activeTab === "jobs") renderJobs();
}

function primarySites() {
  return state.sites.filter((site) => !site.isAlias);
}

function renderSummary() {
  const sites = primarySites();
  $("#siteCount").textContent = sites.length;
  $("#poolCount").textContent = state.pools.length;
  $("#cacheCount").textContent = sites.filter((site) => site.state?.fastcgiCache).length;
  $("#redisCount").textContent = sites.filter((site) => site.state?.redis).length;
  const enabled = [];
  if (state.status?.integrations?.npm) enabled.push("NPM");
  if (state.status?.integrations?.cloudflare) enabled.push("Cloudflare");
  if (state.status?.integrations?.cloudflareSecurity) enabled.push("WAF");
  if (state.status?.integrations?.ipinfo) enabled.push("IPinfo");
  enabled.push("MySQL");
  $("#integrationSummary").textContent = `${enabled.join(" · ")} ready`;
}

function formatBytes(value) {
  let bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit += 1;
  }
  return `${bytes >= 100 || unit === 0 ? bytes.toFixed(0) : bytes.toFixed(1)} ${units[unit]}`;
}

function renderRankList(target, rows, valueKey) {
  const container = $(target);
  container.className = rows.length ? "rank-list" : "rank-list empty";
  container.innerHTML = rows.length ? rows.map((row) => `
    <div><code>${escapeHtml(row[valueKey])}</code><strong>${escapeHtml(row.requests)}</strong></div>
  `).join("") : "No matching requests in the current log sample.";
}

function renderStats() {
  const stats = state.stats;
  if (!stats) return;
  const server = stats.server || {};
  const memoryPercent = server.memoryTotalBytes
    ? (server.memoryUsedBytes / server.memoryTotalBytes) * 100
    : 0;
  const diskPercent = server.disk?.totalBytes
    ? (server.disk.usedBytes / server.disk.totalBytes) * 100
    : 0;
  const phpMemory = (stats.phpPools || []).reduce((total, pool) => total + Number(pool.rssBytes || 0), 0);
  const phpWorkers = (stats.phpPools || []).reduce((total, pool) => total + Number(pool.workers || 0), 0);
  $("#statsUpdated").textContent = `${stats.cached ? "Cached" : "Updated"} ${new Date(stats.generatedAt).toLocaleString()}`;
  $("#statsLoad").textContent = Number(server.load1 || 0).toFixed(2);
  $("#statsLoadDetail").textContent = `${Number(server.load1 || 0).toFixed(2)} / ${Number(server.load5 || 0).toFixed(2)} / ${Number(server.load15 || 0).toFixed(2)}`;
  $("#statsMemory").textContent = `${memoryPercent.toFixed(1)}%`;
  $("#statsMemoryDetail").textContent = `${formatBytes(server.memoryUsedBytes)} of ${formatBytes(server.memoryTotalBytes)}`;
  $("#statsDisk").textContent = `${diskPercent.toFixed(1)}%`;
  $("#statsDiskDetail").textContent = `${formatBytes(server.disk?.usedBytes)} of ${formatBytes(server.disk?.totalBytes)}`;
  $("#statsPhpMemory").textContent = formatBytes(phpMemory);
  $("#statsPhpDetail").textContent = `${phpWorkers} active worker${phpWorkers === 1 ? "" : "s"}`;

  const redis = stats.redis;
  const opcache = stats.opcache;
  const opcacheRows = opcache?.enabled ? `
    <div><dt>OPcache memory</dt><dd>${formatBytes(opcache.memory?.usedBytes)} / ${formatBytes(Number(opcache.memory?.usedBytes || 0) + Number(opcache.memory?.freeBytes || 0))}</dd></div>
    <div><dt>OPcache hit rate</dt><dd>${Number(opcache.statistics?.hitRate || 0).toFixed(1)}%</dd></div>
    <div><dt>Cached PHP scripts</dt><dd>${escapeHtml(opcache.statistics?.cachedScripts || 0)}</dd></div>
    <div><dt>OPcache state</dt><dd>${opcache.cacheFull ? "Full" : opcache.restartPending ? "Restart pending" : "Healthy"}</dd></div>
  ` : `<div><dt>OPcache</dt><dd>${opcache ? "Disabled" : "Unavailable"}</dd></div>`;
  $("#cacheStats").innerHTML = opcacheRows + (redis ? `
    <div><dt>Redis memory</dt><dd>${escapeHtml(redis.usedMemoryHuman)} / ${escapeHtml(redis.maxMemoryHuman || "unlimited")}</dd></div>
    <div><dt>Redis hit rate</dt><dd>${escapeHtml(redis.hitRate)}%</dd></div>
    <div><dt>Redis operations</dt><dd>${escapeHtml(redis.operationsPerSecond)}/s</dd></div>
    <div><dt>Redis keys</dt><dd>${escapeHtml(redis.keys)}</dd></div>
    <div><dt>Redis evictions</dt><dd>${escapeHtml(redis.evictedKeys)}</dd></div>
    <div><dt>FastCGI cache</dt><dd>${formatBytes(stats.fastcgi?.cacheBytes)}</dd></div>
  ` : `<div><dt>Redis</dt><dd>Unavailable</dd></div><div><dt>FastCGI cache</dt><dd>${formatBytes(stats.fastcgi?.cacheBytes)}</dd></div>`);

  $("#containerStats").innerHTML = (stats.containers || []).map((container) => `
    <tr><td data-label="Container"><strong>${escapeHtml(container.name)}</strong></td><td data-label="CPU">${escapeHtml(container.cpuPercent.toFixed(1))}%</td><td data-label="Memory">${escapeHtml(container.memoryUsage)}</td><td data-label="PIDs">${escapeHtml(container.pids)}</td></tr>
  `).join("") || '<tr class="empty-row"><td colspan="4" class="muted">Container statistics unavailable.</td></tr>';

  const pools = new Map((stats.phpPools || []).map((pool) => [pool.name, pool]));
  const sites = primarySites().map((site) => ({ site, pool: pools.get(site.poolName) || { workers: 0, cpuPercent: 0, rssBytes: 0 } }))
    .sort((left, right) => right.pool.cpuPercent - left.pool.cpuPercent || right.pool.rssBytes - left.pool.rssBytes || left.site.host.localeCompare(right.site.host));
  $("#websiteStats").innerHTML = sites.map(({ site, pool }) => `
    <tr>
      <td data-label="Website"><strong>${escapeHtml(site.host)}</strong></td><td data-label="Workers">${escapeHtml(pool.workers)}</td><td data-label="CPU">${Number(pool.cpuPercent || 0).toFixed(1)}%</td>
      <td data-label="RAM">${formatBytes(pool.rssBytes)}</td><td data-label="Pool"><code>${escapeHtml(site.poolName || "-")}</code></td>
      <td data-label="Actions"><button type="button" class="secondary" data-inspect-stats="${escapeHtml(site.host)}">Inspect</button></td>
    </tr>
  `).join("");
  const current = $("#statsDomain").value;
  $("#statsDomain").innerHTML = primarySites().map((site) => `<option value="${escapeHtml(site.host)}">${escapeHtml(site.host)}</option>`).join("");
  if (current && primarySites().some((site) => site.host === current)) $("#statsDomain").value = current;
  if (stats.warnings?.length) notice(stats.warnings.join(" · "), "warning");
}

function renderSiteStats() {
  const stats = state.siteStats;
  if (!stats) return;
  $("#siteStatsDetail").classList.remove("hidden");
  $("#siteStatsTitle").textContent = stats.domain;
  $("#siteStatsUpdated").textContent = `${stats.cached ? "Cached" : "Updated"} ${new Date(stats.generatedAt).toLocaleString()} · ${stats.traffic.sampledLines} log lines sampled`;
  $("#siteStatsDisk").textContent = formatBytes(stats.diskBytes);
  $("#siteStatsRequests").textContent = stats.traffic.requests;
  $("#siteStatsBytes").textContent = formatBytes(stats.traffic.bytes);
  $("#siteStatsLatest").textContent = stats.traffic.latestAt || "No requests";
  const total = Math.max(1, stats.traffic.requests);
  $("#siteStatusStats").innerHTML = Object.entries(stats.traffic.statusGroups || {}).map(([label, count]) => `
    <div><span>${escapeHtml(label)}</span><span class="bar-track"><i style="width:${Math.max(0, Math.min(100, (count / total) * 100))}%"></i></span><strong>${escapeHtml(count)}</strong></div>
  `).join("");
  const ipRows = stats.traffic.topIps || [];
  const ipContainer = $("#siteIpStats");
  ipContainer.className = ipRows.length ? "rank-list ip-rank-list" : "rank-list empty";
  ipContainer.innerHTML = ipRows.length ? ipRows.map((row) => {
    const info = state.ipinfo[row.ip];
    const location = info ? [info.city, info.region, info.country].filter(Boolean).join(", ") || "Location unavailable" : "";
    const organization = info ? [info.asn, info.organization, info.network].filter(Boolean).join(" · ") || "Network details unavailable" : "";
    const signals = info ? Object.entries(info.indicators || {}).map(([name, value]) => `${name}: ${value === null ? "unavailable" : value ? "yes" : "no"}`).join(" · ") : "";
    return `<div class="ip-rank-row"><code>${escapeHtml(row.ip)}</code><strong>${escapeHtml(row.requests)}</strong><button type="button" class="secondary" data-ipinfo-lookup="${escapeHtml(row.ip)}">Look up</button>${info ? `<p>${escapeHtml(location)}<br>${escapeHtml(organization)}${info.hostname ? `<br>${escapeHtml(info.hostname)}` : ""}<br>${escapeHtml(signals)} · ${info.cached ? "cached" : "live"}</p>` : ""}</div>`;
  }).join("") : "No matching requests in the current log sample.";
  renderRankList("#sitePathStats", stats.traffic.topPaths || [], "path");
  if (stats.warnings?.length) notice(stats.warnings.join(" · "), "warning");
}

async function loadStats(force = false) {
  state.stats = await api(`/api/stats/runtime${force ? "?refresh=1" : ""}`);
  renderStats();
}

function deliveryLabel(delivery) {
  if (!delivery) return "Notifications disabled";
  const channels = Object.entries(delivery.channels || {}).map(([name, result]) => `${name}: ${result.status}`);
  return channels.length ? channels.join(" · ") : delivery.status;
}

function renderHealth() {
  const health = state.health;
  if (!health) return;
  const summary = health.summary || {};
  $("#healthOverall").textContent = !health.lastCheckAt ? "Not checked" : summary.critical ? "Critical" : summary.warning ? "Warning" : "Healthy";
  $("#healthCritical").textContent = summary.critical || 0;
  $("#healthWarnings").textContent = summary.warning || 0;
  $("#healthDuration").textContent = health.lastCheckAt ? `${health.lastCheckDurationMs || 0} ms` : "-";
  $("#healthUpdated").textContent = health.lastCheckAt
    ? `Last checked ${new Date(health.lastCheckAt).toLocaleString()}${health.settings?.enabled ? ` · every ${health.settings.intervalMinutes} minutes` : " · scheduled checks disabled"}`
    : "No health check has run.";
  const active = health.active || [];
  $("#healthActive").className = active.length ? "health-list" : "health-list empty";
  $("#healthActive").innerHTML = active.length ? active.map((item) => `
    <div class="health-row">
      <span class="health-severity ${escapeHtml(item.severity)}">${escapeHtml(item.severity)}</span>
      <div><strong>${escapeHtml(item.label)}</strong><p>${escapeHtml(item.message)}</p><small>${escapeHtml(item.target)} · since ${new Date(item.openedAt).toLocaleString()}</small></div>
    </div>`).join("") : "No active incidents.";
  const history = health.history || [];
  $("#healthHistory").className = history.length ? "health-list" : "health-list empty";
  $("#healthHistory").innerHTML = history.length ? history.map((event) => `
    <div class="health-row">
      <span class="health-severity ${escapeHtml(event.severity)}">${escapeHtml(event.transition)}</span>
      <div><strong>${escapeHtml(event.label)}</strong><p>${escapeHtml(event.message)}</p><small>${new Date(event.at).toLocaleString()} · ${escapeHtml(deliveryLabel(event.delivery))}</small></div>
    </div>`).join("") : "No health events recorded.";
}

async function loadHealth() {
  const data = await api("/api/health");
  state.health = data.health;
  renderHealth();
}

async function loadSiteStats(domain, force = false) {
  const selected = domain || $("#statsDomain").value;
  if (!selected) return;
  $("#statsDomain").value = selected;
  state.siteStats = await api(`/api/stats/site?domain=${encodeURIComponent(selected)}${force ? "&refresh=1" : ""}`);
  renderSiteStats();
}

function renderSites() {
  const query = $("#siteSearch").value.trim().toLowerCase();
  const sites = primarySites().filter((site) =>
    [site.host, ...(site.aliases || [])].some((host) => host.toLowerCase().includes(query))
  );
  const container = $("#sitesList");
  if (!sites.length) {
    container.innerHTML = '<div class="panel muted">No matching websites.</div>';
    return;
  }
  container.innerHTML = sites.map((site) => {
    const wordpress = site.state?.siteType !== "static";
    return `
    <article class="site-row">
      <div class="site-identity"><h3>${escapeHtml(site.host)}</h3><p>${escapeHtml(site.root)}</p>${site.aliases?.length ? `<p>Aliases: ${site.aliases.map(escapeHtml).join(", ")}</p>` : ""}</div>
      <div class="site-runtime">
        <strong>${escapeHtml(site.poolName || "No pool")}</strong>
        <p>Port ${escapeHtml(site.port || "—")}</p>
        <label class="site-tier">PHP profile
          <select data-site-pool-tier="${escapeHtml(site.host)}" data-pool-name="${escapeHtml(site.poolName)}" data-pool-port="${escapeHtml(site.port)}">
            ${site.poolTier === "custom" ? '<option value="custom" selected disabled>Custom</option>' : ""}
            ${Object.keys(state.tiers).map((tier) => `<option value="${escapeHtml(tier)}" ${tier === site.poolTier ? "selected" : ""}>${escapeHtml(tier)}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="site-flags">
        <span class="badge on">${site.state?.siteType === "static" ? "HTML/PHP" : "WordPress"}</span>
        <span class="badge ${site.state?.fastcgiCache ? "on" : ""}">FastCGI ${site.state?.fastcgiCache ? "on" : "off"}</span>
        ${wordpress ? `<span class="badge ${site.state?.redis ? "on" : ""}">Redis ${site.state?.redis ? "on" : "off"}</span>` : ""}
        <span class="badge ${site.state?.opcache !== false ? "on" : ""}">OPcache ${site.state?.opcache !== false ? "on" : "off"}</span>
        <span class="badge ${state.backupSettings?.siteBackupsEnabled && site.state?.backupEnabled ? "on" : ""}">Backup ${state.backupSettings?.siteBackupsEnabled === false ? "paused" : site.state?.backupEnabled ? "daily" : "off"}</span>
        <span class="badge ${state.imageOptimization?.settings?.enabled && site.state?.imageOptimizationEnabled ? "on" : ""}">Images ${state.imageOptimization?.settings?.enabled === false ? "paused" : site.state?.imageOptimizationEnabled ? "daily" : "manual"}</span>
      </div>
      <div class="site-actions">
        <label class="site-mobile-action">Site action
          <select data-site-action="${escapeHtml(site.host)}" aria-label="Choose an action for ${escapeHtml(site.host)}">
            <option value="">Choose action</option>
            <option value="backup" ${state.backupSettings?.siteBackupsEnabled === false ? "disabled" : ""}>Back up now</option>
            <option value="backup-schedule">${site.state?.backupEnabled ? "Disable" : "Enable"} daily backup</option>
            <option value="optimize">Optimize images</option>
            <option value="image-schedule">${site.state?.imageOptimizationEnabled ? "Disable" : "Enable"} daily image optimization</option>
            <option value="fastcgi">${site.state?.fastcgiCache ? "Disable" : "Enable"} FastCGI</option>
            ${wordpress ? `<option value="redis">${site.state?.redis ? "Disable" : "Enable"} Redis</option>` : ""}
            <option value="opcache">${site.state?.opcache !== false ? "Disable" : "Enable"} OPcache</option>
            <option value="purge">Purge cache</option>
            <option value="manage">Manage DNS &amp; SSL</option>
          </select>
        </label>
        <button class="secondary" data-toggle-backup="${escapeHtml(site.host)}">${site.state?.backupEnabled ? "Disable" : "Enable"} daily backup</button>
        <button class="secondary" data-toggle-image-optimization="${escapeHtml(site.host)}">${site.state?.imageOptimizationEnabled ? "Disable" : "Enable"} daily images</button>
        <button class="secondary site-action-primary" data-backup-site="${escapeHtml(site.host)}" ${state.backupSettings?.siteBackupsEnabled === false ? "disabled" : ""}>Back up</button>
        <button class="secondary" data-optimize-images="${escapeHtml(site.host)}">Optimize images</button>
        <button class="secondary" data-toggle-fastcgi="${escapeHtml(site.host)}">${site.state?.fastcgiCache ? "Disable" : "Enable"} FastCGI</button>
        ${wordpress ? `<button class="secondary" data-toggle-redis="${escapeHtml(site.host)}">${site.state?.redis ? "Disable" : "Enable"} Redis</button>` : ""}
        <button class="secondary" data-toggle-opcache="${escapeHtml(site.host)}">${site.state?.opcache !== false ? "Disable" : "Enable"} OPcache</button>
        <button class="secondary" data-purge-cache="${escapeHtml(site.host)}">Purge cache</button>
        <button class="site-action-primary" data-manage-site="${escapeHtml(site.host)}">DNS &amp; SSL</button>
      </div>
    </article>`;
  }).join("");
}

function renderImageOptimization() {
  const status = state.imageOptimization || {};
  const button = $("#optimizeAllImages");
  const label = $("#imageOptimizationStatus");
  button.disabled = Boolean(status.running);
  button.textContent = status.running ? `Optimizing ${status.completed || 0}/${status.total || 0}` : "Optimize all images";
  if (status.running) {
    label.textContent = status.currentDomain || "Starting...";
  } else if (status.finishedAt) {
    const created = (status.results || []).reduce((total, result) => total + Number(result.created || 0), 0);
    const saved = (status.results || []).reduce((total, result) => total + Number(result.bytesSaved || 0), 0);
    label.textContent = `${status.message || "Completed"} · ${created} WebP · ${formatBytes(saved)} saved`;
  } else {
    label.textContent = "";
  }
  window.clearTimeout(imageOptimizationPollTimer);
  if (status.running) {
    imageOptimizationPollTimer = window.setTimeout(async () => {
      try {
        state.imageOptimization = await api("/api/sites/images/status");
        renderImageOptimization();
      } catch (error) {
        notice(error.message, "warning");
      }
    }, 5000);
  }
}

function maintenanceOperationLabel(operation) {
  return { transients: "Expired transients", trash: "Trash and spam", cron: "Due WP-Cron", database: "Database optimize", redis: "Redis cache flush" }[operation] || operation;
}

function renderMaintenance() {
  const data = state.maintenance || {};
  const settings = data.settings || {};
  const status = data.status || {};
  const selected = new Set($$("[data-maintenance-site]:checked").map((input) => input.value));
  const form = $("#maintenanceSettingsForm");
  form.elements.enabled.checked = Boolean(settings.enabled);
  form.elements.weekday.value = String(settings.weekday ?? 0);
  form.elements.schedule_time.value = settings.scheduleTime || "05:00";
  $$('[name="scheduled_operation"]').forEach((input) => { input.checked = (settings.operations || []).includes(input.value); });

  const detail = status.running
    ? `${status.message || "Maintenance is running"}\n${status.currentDomain || "Starting..."}\n${status.completed || 0} of ${status.total || 0} websites completed`
    : status.finishedAt
      ? `${status.message || "Maintenance completed"}\nFinished ${new Date(status.finishedAt).toLocaleString()}\n${status.completed || 0} of ${status.total || 0} websites completed`
      : "No maintenance has run.";
  $("#maintenanceStatus").textContent = detail;
  $("#runMaintenance").disabled = Boolean(status.running);
  $("#runMaintenance").textContent = status.running ? `Running ${status.completed || 0}/${status.total || 0}` : "Run selected websites";

  const results = status.results || [];
  $("#maintenanceResults").classList.toggle("empty", !results.length);
  $("#maintenanceResults").innerHTML = results.length ? results.map((result) => {
    const operations = (result.operations || []).map((operation) => {
      const detail = operation.ok ? "complete" : `failed${operation.message ? ` (${String(operation.message).trim().slice(0, 180)})` : ""}`;
      return `${maintenanceOperationLabel(operation.operation)}: ${detail}`;
    }).join(" · ");
    return `<div class="maintenance-result ${result.ok ? "" : "has-error"}"><strong>${escapeHtml(result.domain)}</strong><span>${escapeHtml(operations || result.message || "No result details")}</span></div>`;
  }).join("") : "No results.";

  const sites = primarySites().filter((site) => site.state?.siteType !== "static");
  $("#maintenanceSites").innerHTML = sites.length ? sites.map((site) => `
    <div class="maintenance-site-row">
      <label class="check"><input type="checkbox" data-maintenance-site value="${escapeHtml(site.host)}" ${selected.has(site.host) ? "checked" : ""} /><span><strong>${escapeHtml(site.host)}</strong><small>${escapeHtml(site.poolName || "WordPress")}</small></span></label>
      <label class="check weekly-check"><input type="checkbox" data-maintenance-weekly="${escapeHtml(site.host)}" ${site.state?.maintenanceEnabled ? "checked" : ""} /> Weekly</label>
    </div>`).join("") : '<div class="muted">No WordPress websites are configured.</div>';

  window.clearTimeout(maintenancePollTimer);
  if (status.running) {
    maintenancePollTimer = window.setTimeout(() => loadMaintenance().catch((error) => notice(error.message, "warning")), 3000);
  }
}

async function loadMaintenance() {
  state.maintenance = await api("/api/maintenance/status");
  renderMaintenance();
}

function jobStatusLabel(status) {
  return String(status || "unknown").replaceAll("_", " ");
}

function jobTypeLabel(type) {
  return {
    "backup.site": "Website backup",
    "backup.sites": "Website backups",
    "backup.app-data": "Application-data backup",
    "backup.restore": "Website restore",
    "backup.schedule": "Scheduled backup",
    "images.optimize": "Image optimization",
    "wordpress.maintenance": "WordPress maintenance",
    "site.provision": "Website provisioning",
    "site.remove": "Website deletion",
  }[type] || type;
}

function renderJobs() {
  const allJobs = state.jobs || [];
  const statusFilter = $("#jobStatusFilter").value;
  const typeFilter = $("#jobTypeFilter").value;
  const types = [...new Set(allJobs.map((job) => job.type))].sort();
  $("#jobTypeFilter").innerHTML = ["<option value=\"\">All types</option>", ...types.map((type) =>
    `<option value="${escapeHtml(type)}" ${type === typeFilter ? "selected" : ""}>${escapeHtml(jobTypeLabel(type))}</option>`
  )].join("");

  $("#jobsRunning").textContent = allJobs.filter((job) => ["running", "cancelling"].includes(job.status)).length;
  $("#jobsQueued").textContent = allJobs.filter((job) => job.status === "queued").length;
  $("#jobsFailed").textContent = allJobs.filter((job) => ["failed", "partially_succeeded"].includes(job.status)).length;
  $("#jobsCompleted").textContent = allJobs.filter((job) => job.status === "succeeded").length;

  const jobs = allJobs
    .filter((job) => !statusFilter || job.status === statusFilter)
    .filter((job) => !typeFilter || job.type === typeFilter);
  const list = $("#jobsList");
  list.className = jobs.length ? "job-list" : "job-list empty";
  list.innerHTML = jobs.length ? jobs.map((job) => {
    const total = Number(job.total || 0);
    const completed = Number(job.completed || 0);
    const terminal = ["succeeded", "failed", "partially_succeeded", "cancelled"].includes(job.status);
    const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : job.status === "succeeded" ? 100 : 0;
    const blocker = job.waitingFor?.length ? `Waiting for ${job.waitingFor.map((item) => item.label).join(", ")}` : "";
    const detail = job.error || blocker || job.currentStep || job.message || "";
    const notification = job.notifications?.at(-1);
    const notificationText = notification
      ? `Alert ${notification.status}: ${Object.entries(notification.channels || {}).map(([name, value]) => `${name} ${value.status}`).join(", ")}`
      : "";
    const canCancel = job.status === "queued" || (job.status === "running" && job.cancellable);
    const canRetry = terminal && job.retryable && job.status !== "succeeded";
    const canReveal = job.status === "succeeded" && job.oneTimeAccessAvailable;
    return `<div class="job-row">
      <div><span class="job-status ${escapeHtml(job.status)}">${escapeHtml(jobStatusLabel(job.status))}</span><h3>${escapeHtml(job.label)}</h3><p>${escapeHtml(jobTypeLabel(job.type))} · ${escapeHtml(job.operator || "system")}</p></div>
      <div class="job-progress"><div class="job-progress-track"><i style="width:${percent}%"></i></div><p>${total ? `${completed} of ${total}` : jobStatusLabel(job.status)}${job.currentStep ? ` · ${escapeHtml(job.currentStep)}` : ""}</p></div>
      <div><p>${escapeHtml(detail)}</p><p>${escapeHtml(new Date(job.startedAt || job.createdAt).toLocaleString())}${job.finishedAt ? ` · finished ${escapeHtml(new Date(job.finishedAt).toLocaleString())}` : ""}</p>${notificationText ? `<p>${escapeHtml(notificationText)}</p>` : ""}</div>
      <div class="job-actions">${canReveal ? `<button class="secondary" data-reveal-provision="${job.id}">Reveal credentials</button>` : ""}${canCancel ? `<button class="secondary danger-button" data-cancel-job="${job.id}">Cancel</button>` : ""}${canRetry ? `<button class="secondary" data-retry-job="${job.id}">Retry</button>` : ""}</div>
    </div>`;
  }).join("") : "No jobs match the selected filters.";

  window.clearTimeout(jobsPollTimer);
  if (state.activeTab === "jobs" && allJobs.some((job) =>
    ["queued", "running", "cancelling"].includes(job.status)
    || ["queued", "retrying"].includes(job.notifications?.at(-1)?.status))) {
    jobsPollTimer = window.setTimeout(() => loadJobs().catch((error) => notice(error.message, "warning")), 3000);
  }
}

async function loadJobs() {
  const previous = new Map((state.jobs || []).map((job) => [job.id, job.status]));
  const response = await api("/api/jobs?limit=100");
  state.jobs = response.jobs || [];
  renderJobs();
  if (state.jobs.some((job) => job.type === "site.provision" && job.status === "succeeded"
      && previous.has(job.id) && previous.get(job.id) !== "succeeded")) {
    await loadData();
  }
}

function renderDomainOptions() {
  const domains = primarySites().map((site) => site.host);
  if (!state.selectedDomain || !domains.includes(state.selectedDomain)) state.selectedDomain = domains[0] || "";
  $("#integrationDomain").innerHTML = domains.map((domain) =>
    `<option value="${escapeHtml(domain)}" ${domain === state.selectedDomain ? "selected" : ""}>${escapeHtml(domain)}</option>`
  ).join("");
  $("#securityDomain").innerHTML = domains.map((domain) =>
    `<option value="${escapeHtml(domain)}" ${domain === state.selectedDomain ? "selected" : ""}>${escapeHtml(domain)}</option>`
  ).join("");
}

function renderRemovalOptions() {
  const domains = primarySites().map((site) => site.host);
  const select = $("#removalDomain");
  const current = select.value;
  select.innerHTML = domains.map((domain) => `<option value="${escapeHtml(domain)}">${escapeHtml(domain)}</option>`).join("");
  if (current && domains.includes(current)) select.value = current;
}

function renderRemovalPlan() {
  const plan = state.removalPlan;
  const summary = $("#removalPlanSummary");
  const form = $("#siteRemovalForm");
  if (!plan) {
    summary.textContent = "No website selected.";
    return;
  }
  summary.textContent = [
    `Website: ${plan.domain}`,
    `Aliases: ${plan.targetDomains.filter((domain) => domain !== plan.domain).join(", ") || "none"}`,
    `Directory: ${plan.directory}`,
    `Pool: ${plan.pool.name || "not detected"}`,
    `Database: ${plan.database?.name || "not detected"}`,
    ...(plan.warnings || []).map((warning) => `Warning: ${warning}`),
  ].join("\n");
  const fields = {
    final_backup: "finalBackup",
    runtime: "runtime",
    pool: "pool",
    files: "files",
    database: "database",
    npm_host: "npmHost",
    npm_certificate: "npmCertificate",
    cloudflare_dns: "cloudflareDns",
    panel_state: "panelState",
    backups: "backups",
  };
  for (const [fieldName, resourceName] of Object.entries(fields)) {
    const resource = plan.resources[resourceName];
    const input = form.elements[fieldName];
    const detail = $(`[data-removal-detail="${resourceName}"]`);
    const unavailable = !resource?.available;
    const unsafe = resource?.available && !resource.safe;
    input.disabled = unavailable || unsafe;
    input.checked = !input.disabled && fieldName !== "backups";
    const items = (resource?.items || []).join(", ");
    const shared = (resource?.sharedBy || []).join(", ");
    detail.textContent = unavailable
      ? "Not detected or integration unavailable."
      : unsafe
        ? `Protected because it is shared or could not be verified${shared ? `: ${shared}` : ""}.`
        : `${resource.count} item${resource.count === 1 ? "" : "s"}${items ? `: ${items}` : ""}`;
  }
  form.elements.confirm_domain.value = "";
}

async function loadRemovalPlan() {
  renderRemovalOptions();
  const domain = $("#removalDomain").value;
  if (!domain) {
    state.removalPlan = null;
    renderRemovalPlan();
    return;
  }
  const result = await api(`/api/site-removal?domain=${encodeURIComponent(domain)}`);
  state.removalPlan = result.plan;
  renderRemovalPlan();
}

function renderSecurityRules() {
  const container = $("#securityRules");
  const rules = state.securityRules || [];
  container.className = rules.length ? "rows" : "rows empty";
  container.innerHTML = rules.length ? rules.map((rule) => `
    <div class="security-rule-row">
      <div><strong>${escapeHtml(rule.description)}</strong><p>${escapeHtml(rule.action)} · ${escapeHtml(rule.phase === "http_ratelimit" ? "rate limit" : "WAF")}</p></div>
      <label class="check"><input type="checkbox" data-security-toggle="${escapeHtml(rule.id)}" data-ruleset-id="${escapeHtml(rule.rulesetId)}" ${rule.enabled ? "checked" : ""} /> Enabled</label>
      <button type="button" class="secondary danger-button" data-security-delete="${escapeHtml(rule.id)}" data-ruleset-id="${escapeHtml(rule.rulesetId)}">Remove</button>
    </div>
  `).join("") : "No Hosting Control security rules are applied to this website.";
}

async function loadSecurity() {
  renderDomainOptions();
  const configured = Boolean(state.status?.integrations?.cloudflareSecurity);
  $("#securityUnavailable").classList.toggle("hidden", configured);
  $$('[data-security-preset]').forEach((button) => { button.disabled = !configured; });
  if (!configured || !state.selectedDomain) {
    state.securityRules = [];
    $("#securityZone").textContent = configured ? "No website selected." : "Security token is not configured.";
    renderSecurityRules();
    return;
  }
  const data = await api(`/api/cloudflare/security?domain=${encodeURIComponent(state.selectedDomain)}`);
  state.securityRules = data.rules || [];
  $("#securityZone").textContent = `Zone: ${data.zone.name} · website: ${data.domain}`;
  renderSecurityRules();
}

function renderBackupOptions() {
  const names = ["app-data", ...primarySites().map((site) => site.host)];
  if (!names.includes(state.backupName)) state.backupName = "app-data";
  $("#backupDomain").innerHTML = names.map((name) =>
    `<option value="${escapeHtml(name)}" ${name === state.backupName ? "selected" : ""}>${name === "app-data" ? "Application data" : escapeHtml(name)}</option>`
  ).join("");
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

function renderBackupStatus() {
  const status = state.backupStatus || {};
  const settings = state.backupSettings || {};
  const siteActionsDisabled = settings.siteBackupsEnabled === false || status.busy;
  $("#backupEnabledSites").disabled = siteActionsDisabled;
  $("#backupAllSites").disabled = siteActionsDisabled;
  $("#backupAppData").disabled = status.busy;
  if (status.busy) {
    const progress = Number.isInteger(status.currentJob?.total)
      ? `\nProgress: ${status.currentJob.completed || 0}/${status.currentJob.total}${status.currentJob.domain ? ` · ${status.currentJob.domain}` : ""}`
      : "";
    $("#backupStatus").textContent = `${status.currentJob?.label || "Backup"} is running.${progress}\nStarted: ${new Date(status.currentJob?.startedAt).toLocaleString()}`;
    return;
  }
  const last = status.lastResult;
  $("#backupStatus").textContent = [
    "No backup is currently running.",
    `Daily start: ${settings.scheduleTime || "03:00"}`,
    `Retention: ${settings.retention || 7} backup sets`,
    `Website backups: ${settings.siteBackupsEnabled === false ? "paused" : "enabled"}`,
    last ? `Last result: ${last.ok === false ? "failed" : "complete"} at ${new Date(last.finishedAt).toLocaleString()}${last.message ? `\n${last.message}` : ""}` : "No backup has run since the panel started.",
  ].join("\n");
}

async function monitorBackupJob() {
  while (state.backupStatus?.busy) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const data = await api("/api/backups/settings");
    state.backupSettings = data.settings;
    state.backupStatus = data.status;
    renderBackupStatus();
  }
  await loadBackupView();
}

function renderBackupHistory(backups) {
  const container = $("#backupHistory");
  if (!backups.length) {
    container.className = "rows empty";
    container.textContent = "No backup sets stored for this selection.";
    return;
  }
  container.className = "rows";
  container.innerHTML = backups.map((backup) => `
    <div class="backup-row">
      <div><strong>${escapeHtml(backup.id)}</strong><p>${escapeHtml(new Date(backup.completedAt || backup.startedAt || "").toLocaleString())}</p></div>
      <div><span>${backup.database ? `Database: ${escapeHtml(backup.database)}` : "All application databases"}</span><p>${formatBytes(backup.size)}</p></div>
      <div class="backup-actions">
        ${state.backupName === "app-data" ? "" : `<button class="secondary" data-restore-backup="${escapeHtml(backup.id)}">Restore</button>`}
        <button class="secondary danger-button" data-delete-backup="${escapeHtml(backup.id)}">Delete</button>
      </div>
    </div>
  `).join("");
}

async function loadBackupView() {
  renderBackupOptions();
  renderRemovalOptions();
  const [data, history] = await Promise.all([
    api("/api/backups/settings"),
    api(`/api/backups?name=${encodeURIComponent(state.backupName)}`),
  ]);
  state.backupSettings = data.settings;
  state.backupStatus = data.status;
  $("#backupSettingsForm").elements.schedule_time.value = data.settings.scheduleTime;
  $("#backupSettingsForm").elements.retention.value = data.settings.retention;
  $("#backupSettingsForm").elements.site_backups_enabled.checked = data.settings.siteBackupsEnabled;
  $("#backupSettingsForm").elements.app_data_enabled.checked = data.settings.appDataEnabled;
  renderBackupStatus();
  renderBackupHistory(history.backups || []);
}

function renderPools() {
  $("#poolsTable").innerHTML = state.pools.map((pool) => `
    <tr>
      <td><input data-pool-field="name" value="${escapeHtml(pool.name)}" /></td>
      <td><input data-pool-field="port" type="number" value="${escapeHtml(pool.port)}" /></td>
      <td><select data-pool-field="tier">${Object.keys(state.tiers).map((tier) =>
        `<option value="${escapeHtml(tier)}" ${tier === pool.tier ? "selected" : ""}>${escapeHtml(tier)}</option>`
      ).join("")}</select></td>
      <td>${escapeHtml((pool.hosts || []).join(", "))}</td>
    </tr>
  `).join("");
}

function renderHosts() {
  const poolOptions = state.pools.map((pool) => pool.name);
  $("#hostsTable").innerHTML = state.sites.map((site) => `
    <tr>
      <td><input data-host-field="host" value="${escapeHtml(site.host)}" /></td>
      <td><input data-host-field="root" value="${escapeHtml(site.root)}" /></td>
      <td><select data-host-field="pool_name">${poolOptions.map((name) =>
        `<option value="${escapeHtml(name)}" ${name === site.poolName ? "selected" : ""}>${escapeHtml(name)}</option>`
      ).join("")}</select></td>
      <td><input data-host-field="canonical_to" value="${escapeHtml(site.canonicalTo || "")}" /></td>
      <td><input data-host-field="add_www_alias" type="checkbox" ${!site.host.startsWith("www.") && state.sites.some((entry) => entry.host === `www.${site.host}` && entry.root === site.root && entry.port === site.port) ? "checked" : ""} /></td>
    </tr>
  `).join("");
}

async function loadData() {
  const [status, siteData, poolData, presetData, backupData, imageOptimization, maintenance, dnsData, ipData, packages] = await Promise.all([
    api("/api/status"),
    api("/api/sites"),
    api("/api/pools"),
    api("/api/pool-presets"),
    api("/api/backups/settings"),
    api("/api/sites/images/status"),
    api("/api/maintenance/status"),
    api("/api/dns-presets"),
    api("/api/cloudflare/ip-addresses"),
    api("/api/wordpress-packages"),
  ]);
  state.status = status;
  state.sites = siteData.sites || [];
  state.pools = poolData.pools || [];
  state.tiers = presetData.tiers || {};
  state.backupSettings = backupData.settings;
  state.backupStatus = backupData.status;
  state.imageOptimization = imageOptimization;
  state.maintenance = maintenance;
  state.dnsPresets = dnsData.presets || [];
  state.cloudflareIps = ipData.addresses || [];
  state.wordpressPackages = packages;
  $("#provisionTier").innerHTML = Object.keys(state.tiers).map((tier) => `<option value="${escapeHtml(tier)}">${escapeHtml(tier)}</option>`).join("");
  renderSummary();
  renderSites();
  renderDomainOptions();
  renderBackupOptions();
  renderPools();
  renderHosts();
  renderImageOptimization();
  renderMaintenance();
  renderDnsPresets();
  renderDnsPresetDraft();
  renderCloudflareIps();
  renderWordPressPackages();
}

async function loadNpm() {
  if (!state.status?.integrations?.npm) {
    state.npmHosts = [];
    $("#npmHostStatus").textContent = "NPM credentials are not configured in the UI container.";
    return;
  }
  const data = await api("/api/npm/hosts");
  state.npmHosts = data.hosts || [];
  renderNpmStatus();
}

function selectedNpmHost() {
  return state.npmHosts.find((host) => (host.domain_names || []).includes(state.selectedDomain));
}

function renderNpmStatus() {
  const host = selectedNpmHost();
  if (!host) {
    $("#npmHostStatus").textContent = `No NPM proxy host is linked to ${state.selectedDomain || "this site"}.`;
    return;
  }
  const certificate = host.certificate;
  $("#npmHostStatus").textContent = [
    `Host #${host.id}: ${host.enabled ? "enabled" : "disabled"}`,
    `Target: ${host.forward_scheme}://${host.forward_host}:${host.forward_port}`,
    certificate ? `SSL: ${certificate.nice_name || "issued"} · expires ${certificate.expires_on || "unknown"}` : "SSL: not attached",
    `Force HTTPS: ${host.ssl_forced ? "yes" : "no"}`,
  ].join("\n");
}

async function loadDns() {
  const domain = state.selectedDomain;
  if (!domain) return;
  if (!state.status?.integrations?.cloudflare) {
    $("#dnsZone").textContent = "Cloudflare token is not configured.";
    $("#dnsRecords").className = "rows empty";
    $("#dnsRecords").textContent = "Cloudflare integration unavailable.";
    return;
  }
  const data = await api(`/api/cloudflare/records?domain=${encodeURIComponent(domain)}`);
  $("#dnsZone").textContent = `Zone: ${data.zone.name} · showing ${data.scope} and its subdomains`;
  const records = data.records || [];
  state.dnsRecords = records;
  $("#dnsRecords").className = records.length ? "rows" : "rows empty";
  $("#dnsRecords").innerHTML = records.length ? records.map((record) => `
    <div class="data-row">
      <strong>${escapeHtml(record.type)}</strong>
      <span>${escapeHtml(record.name)}</span>
      <code>${escapeHtml(record.content)}</code>
      <span>${record.proxied ? "Proxied" : record.ttl === 1 ? "Auto TTL" : `${escapeHtml(record.ttl)}s`}</span>
      <div class="record-actions">
        <button class="secondary" data-edit-dns="${escapeHtml(record.id)}">Edit</button>
        <button class="secondary danger-button" data-delete-dns="${escapeHtml(record.id)}">Delete</button>
      </div>
    </div>
  `).join("") : "No records found for this host or its subdomains.";
  if (!$("#dnsForm").elements.record_id.value) $("#dnsForm").elements.name.value = domain;
}

function resetDnsForm() {
  const form = $("#dnsForm");
  form.reset();
  form.elements.record_id.value = "";
  form.elements.name.value = state.selectedDomain;
  form.elements.ttl.value = "1";
  form.elements.priority.value = "10";
  form.elements.proxied.checked = true;
  $("#saveDnsRecord").textContent = "Add record";
  $("#cancelDnsEdit").classList.add("hidden");
}

function renderDnsPresets() {
  const options = [
    '<option value="">Select a preset</option>',
    ...state.dnsPresets.map((preset) =>
      `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.label)} · ${(preset.records || []).length} record${(preset.records || []).length === 1 ? "" : "s"}</option>`),
  ].join("");
  $("#dnsPresetSelect").innerHTML = options;
  $("#provisionDnsPreset").innerHTML = options;
  const list = $("#dnsPresetList");
  list.className = state.dnsPresets.length ? "rows" : "rows empty";
  list.innerHTML = state.dnsPresets.length ? state.dnsPresets.map((preset) => `
    <div class="data-row preset-row">
      <strong>${(preset.records || []).length}</strong>
      <span>${escapeHtml(preset.label)}</span>
      <code>${(preset.records || []).map((record) => `${escapeHtml(record.type)} ${escapeHtml(record.nameTemplate)} → ${escapeHtml(record.contentTemplate)}`).join(" · ")}</code>
      <span>record${(preset.records || []).length === 1 ? "" : "s"}</span>
      <div class="record-actions">
        <button class="secondary" data-edit-dns-preset="${escapeHtml(preset.id)}">Edit</button>
        <button class="secondary danger-button" data-delete-dns-preset="${escapeHtml(preset.id)}">Delete</button>
      </div>
    </div>
  `).join("") : "No DNS presets saved.";
}

function renderDnsPresetDraft() {
  const list = $("#dnsPresetDraft");
  list.className = state.dnsPresetDraft.length ? "rows" : "rows empty";
  list.innerHTML = state.dnsPresetDraft.length ? state.dnsPresetDraft.map((record) => `
    <div class="preset-draft-row">
      <strong>${escapeHtml(record.type)}</strong>
      <code>${escapeHtml(record.name_template)} → ${escapeHtml(record.content_template)}</code>
      <span>${record.proxied ? "Proxied" : "DNS only"}</span>
      <button type="button" class="secondary danger-button" data-remove-preset-record="${escapeHtml(record.id)}">Remove</button>
    </div>
  `).join("") : "Add at least one record.";
}

function resetDnsPresetForm() {
  const form = $("#dnsPresetForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.name_template.value = "@";
  form.elements.ttl.value = "1";
  form.elements.priority.value = "10";
  form.elements.proxied.checked = true;
  state.dnsPresetDraft = [];
  renderDnsPresetDraft();
  $("#cancelDnsPresetEdit").classList.add("hidden");
}

function presetRecordFromForm(form) {
  const nameTemplate = form.elements.name_template.value.trim();
  const contentTemplate = form.elements.content_template.value.trim();
  if (!nameTemplate || !contentTemplate) throw new Error("Enter the DNS name and content before adding the record");
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: form.elements.type.value,
    name_template: nameTemplate,
    content_template: contentTemplate,
    ttl: Number(form.elements.ttl.value || 1),
    priority: Number(form.elements.priority.value || 10),
    proxied: form.elements.proxied.checked,
  };
}

async function loadDnsPresets() {
  const data = await api("/api/dns-presets");
  state.dnsPresets = data.presets || [];
  renderDnsPresets();
}

function renderCloudflareIps() {
  $("#cloudflareIpForm").elements.addresses.value = state.cloudflareIps.join("\n");
  $("#cloudflareIpOptions").innerHTML = state.cloudflareIps
    .map((address) => `<option value="${escapeHtml(address)}"></option>`).join("");
  $("#provisionDnsIpOptions").innerHTML = state.cloudflareIps
    .map((address) => `<option value="${escapeHtml(address)}"></option>`).join("");
}

async function loadCloudflareIps() {
  const data = await api("/api/cloudflare/ip-addresses");
  state.cloudflareIps = data.addresses || [];
  renderCloudflareIps();
}

function renderWordPressPackages() {
  for (const kind of ["plugins", "themes"]) {
    const packages = state.wordpressPackages[kind] || [];
    const list = $(kind === "plugins" ? "#pluginPackageList" : "#themePackageList");
    list.className = packages.length ? "rows" : "rows empty";
    list.innerHTML = packages.length ? packages.map((item) => `
      <div class="package-row">
        <div><strong>${escapeHtml(item.name)}</strong><span>${formatBytes(item.size)}</span></div>
        <button type="button" class="secondary danger-button" data-delete-package="${escapeHtml(item.id)}" data-package-kind="${kind}">Delete</button>
      </div>
    `).join("") : `No uploaded ${kind}.`;
    const choices = $(kind === "plugins" ? "#provisionPluginPackages" : "#provisionThemePackages");
    choices.className = packages.length ? "package-checks" : "package-checks muted";
    choices.innerHTML = packages.length ? packages.map((item) => `
      <label class="check"><input type="checkbox" data-package-choice="${kind}" value="${escapeHtml(item.id)}" /> ${escapeHtml(item.name)}</label>
    `).join("") : `No uploaded ${kind}.`;
  }
}

async function loadWordPressPackages() {
  state.wordpressPackages = await api("/api/wordpress-packages");
  renderWordPressPackages();
}

async function refreshIntegrationView() {
  renderDomainOptions();
  await Promise.allSettled([loadNpm(), loadDns(), loadDnsPresets()]);
}

async function loadLogs() {
  try {
    const data = await api("/api/logs");
    $("#logViewer").textContent = data.logs || "No log output.";
  } catch (error) {
    $("#logViewer").textContent = error.message;
  }
}

async function loadIntegrationSettings() {
  try {
    const [settings, performanceData, imageData, notificationData, healthData] = await Promise.all([
      api("/api/settings/integrations"),
      api("/api/settings/performance"),
      api("/api/sites/images/status"),
      api("/api/settings/notifications"),
      api("/api/health"),
      loadDnsPresets(),
      loadCloudflareIps(),
    ]);
    const form = $("#integrationSettingsForm");
    form.elements.npmApiUrl.value = settings.npmApiUrl || "";
    form.elements.npmIdentity.value = settings.npmIdentity || "";
    form.elements.acmeEmail.value = settings.acmeEmail || "";
    form.elements.npmSecret.value = "";
    form.elements.npmSecret.placeholder = settings.npmSecretConfigured ? "Saved password configured" : "Enter NPM password";
    form.elements.cloudflareToken.value = "";
    form.elements.cloudflareToken.placeholder = settings.cloudflareTokenConfigured ? "Saved token configured" : "Enter Cloudflare token";
    form.elements.cloudflareSecurityToken.value = "";
    form.elements.cloudflareSecurityToken.placeholder = settings.cloudflareSecurityTokenConfigured ? "Saved security token configured" : "Enter Cloudflare Security token";
    form.elements.ipinfoToken.value = "";
    form.elements.ipinfoToken.placeholder = settings.ipinfoTokenConfigured ? "Saved token configured" : "Enter IPinfo token";
    form.elements.cloudflareAccountId.value = settings.cloudflareAccountId || "";
    form.elements.mysqlContainer.value = settings.mysqlContainer || "hosting-db";
    form.elements.mysqlSitePrefix.value = settings.mysqlSitePrefix || "yogali00_";
    form.elements.clearNpmSecret.checked = false;
    form.elements.clearCloudflareToken.checked = false;
    form.elements.clearCloudflareSecurityToken.checked = false;
    form.elements.clearIpinfoToken.checked = false;
    const notifications = notificationData.settings;
    const notificationForm = $("#notificationSettingsForm");
    notificationForm.elements.installationName.value = notifications.installationName || "Hosting control panel";
    notificationForm.elements.serverName.value = notifications.serverName || "hosting-server";
    notificationForm.elements.panelUrl.value = notifications.panelUrl || "";
    notificationForm.elements.telegramEnabled.checked = notifications.telegramEnabled;
    notificationForm.elements.telegramBotToken.value = "";
    notificationForm.elements.telegramBotToken.placeholder = notifications.telegramBotTokenConfigured ? "Saved token configured" : "Enter Telegram bot token";
    notificationForm.elements.telegramChatIds.value = notifications.telegramChatIds || "";
    notificationForm.elements.clearTelegramBotToken.checked = false;
    notificationForm.elements.smtpEnabled.checked = notifications.smtpEnabled;
    notificationForm.elements.smtpHost.value = notifications.smtpHost || "";
    notificationForm.elements.smtpPort.value = notifications.smtpPort || 587;
    notificationForm.elements.smtpSecure.checked = notifications.smtpSecure;
    notificationForm.elements.smtpUsername.value = notifications.smtpUsername || "";
    notificationForm.elements.smtpPassword.value = "";
    notificationForm.elements.smtpPassword.placeholder = notifications.smtpPasswordConfigured ? "Saved password configured" : "Enter SMTP password";
    notificationForm.elements.smtpFrom.value = notifications.smtpFrom || "";
    notificationForm.elements.smtpRecipients.value = notifications.smtpRecipients || "";
    notificationForm.elements.clearSmtpPassword.checked = false;
    notificationForm.elements.severityFailure.checked = notifications.severityFailure;
    notificationForm.elements.severityWarning.checked = notifications.severityWarning;
    notificationForm.elements.severitySuccess.checked = notifications.severitySuccess;
    state.health = healthData.health;
    const health = state.health.settings;
    const healthForm = $("#healthSettingsForm");
    healthForm.elements.enabled.checked = health.enabled;
    healthForm.elements.intervalMinutes.value = health.intervalMinutes;
    healthForm.elements.diskWarningPercent.value = health.diskWarningPercent;
    healthForm.elements.diskCriticalPercent.value = health.diskCriticalPercent;
    healthForm.elements.certificateWarningDays.value = health.certificateWarningDays;
    healthForm.elements.certificateCriticalDays.value = health.certificateCriticalDays;
    healthForm.elements.opcacheWarningPercent.value = health.opcacheWarningPercent;
    healthForm.elements.requiredContainers.value = (health.requiredContainers || []).join("\n");
    healthForm.elements.publicCheckTimeoutSeconds.value = health.publicCheckTimeoutSeconds;
    healthForm.elements.publicHosts.value = (health.publicHosts || []).join("\n");
    state.performance = performanceData.settings;
    const performance = $("#performanceSettingsForm");
    performance.elements.phpMemoryLimitMb.value = state.performance.php.memoryLimitMb;
    performance.elements.phpMaxExecutionSeconds.value = state.performance.php.maxExecutionSeconds;
    performance.elements.opcacheMemoryMb.value = state.performance.opcache.memoryMb;
    performance.elements.opcacheInternedStringsMb.value = state.performance.opcache.internedStringsMb;
    performance.elements.opcacheMaxFiles.value = state.performance.opcache.maxFiles;
    performance.elements.opcacheRevalidateSeconds.value = state.performance.opcache.revalidateSeconds;
    performance.elements.opcacheValidateTimestamps.checked = state.performance.opcache.validateTimestamps;
    performance.elements.fastcgiKeysZoneMb.value = state.performance.fastcgi.keysZoneMb;
    performance.elements.fastcgiMaxSizeGb.value = state.performance.fastcgi.maxSizeGb;
    performance.elements.fastcgiInactiveMinutes.value = state.performance.fastcgi.inactiveMinutes;
    performance.elements.fastcgiValidMinutes.value = state.performance.fastcgi.validMinutes;
    performance.elements.fastcgiReadTimeoutSeconds.value = state.performance.fastcgi.readTimeoutSeconds;
    performance.elements.fastcgiCacheLock.checked = state.performance.fastcgi.cacheLock;
    performance.elements.redisMaxMemoryMb.value = state.performance.redis.maxMemoryMb;
    performance.elements.redisPolicy.value = state.performance.redis.policy;
    performance.elements.mysqlBufferPoolMb.value = state.performance.mysql.bufferPoolMb;
    performance.elements.mysqlMaxConnections.value = state.performance.mysql.maxConnections;
    performance.elements.mysqlRedoLogCapacityMb.value = state.performance.mysql.redoLogCapacityMb;
    state.imageOptimization = imageData;
    const imageForm = $("#imageOptimizationSettingsForm");
    imageForm.elements.schedule_time.value = imageData.settings?.scheduleTime || "04:00";
    imageForm.elements.enabled.checked = Boolean(imageData.settings?.enabled);
  } catch (error) {
    notice(error.message, "warning");
  }
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  $("#loginError").classList.add("hidden");
  try {
    const session = await withButton(button, "Signing in...", () => api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: $("#loginEmail").value, password: $("#loginPassword").value }),
    }));
    showApp(session);
    await loadData();
  } catch (error) {
    $("#loginError").textContent = error.message;
    $("#loginError").classList.remove("hidden");
  }
});

$("#logoutButton").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  showLogin();
});

$$("[data-tab-link]").forEach((button) => button.addEventListener("click", (event) => {
  event.preventDefault();
  switchTab(button.dataset.tabLink);
}));
$("#mobileNavigation").addEventListener("change", (event) => switchTab(event.target.value));

$("#refreshJobs").addEventListener("click", async (event) => {
  try { await withButton(event.currentTarget, "Refreshing...", loadJobs); }
  catch (error) { notice(error.message, "warning"); }
});
$("#jobStatusFilter").addEventListener("change", renderJobs);
$("#jobTypeFilter").addEventListener("change", renderJobs);
$("#jobsList").addEventListener("click", async (event) => {
  const reveal = event.target.closest("[data-reveal-provision]");
  if (reveal) {
    try {
      const result = await withButton(reveal, "Revealing...", () => api(
        `/api/provision/credentials/${encodeURIComponent(reveal.dataset.revealProvision)}/reveal`,
        { method: "POST" },
      ));
      const credentials = result.credentials;
      const wordpress = credentials.wordpress?.preserved ? "Existing WordPress users were preserved." : `WordPress user: ${escapeHtml(credentials.wordpress?.adminUser || "")}
WordPress password: ${escapeHtml(credentials.wordpress?.adminPassword || "")}
WordPress email: ${escapeHtml(credentials.wordpress?.adminEmail || "")}`;
      $("#provisionResult").innerHTML = `<h3>${escapeHtml(credentials.domain)} credentials</h3><p>These credentials have now been removed from the panel. Store them securely.</p><pre>Database: ${escapeHtml(credentials.database.name)}
Database user: ${escapeHtml(credentials.database.user)}
Database password: ${escapeHtml(credentials.database.password)}

${wordpress}</pre>`;
      $("#provisionResult").classList.remove("hidden");
      switchTab("provision");
      await loadJobs();
    } catch (error) { notice(error.message, "warning"); }
    return;
  }
  const cancel = event.target.closest("[data-cancel-job]");
  const retry = event.target.closest("[data-retry-job]");
  const button = cancel || retry;
  if (!button) return;
  const action = cancel ? "cancel" : "retry";
  if (cancel && !confirm("Cancel this job at its next safe boundary?")) return;
  try {
    const result = await withButton(button, action === "cancel" ? "Cancelling..." : "Queuing...", () => api(
      `/api/jobs/${encodeURIComponent(cancel?.dataset.cancelJob || retry.dataset.retryJob)}/${action}`,
      { method: "POST" },
    ));
    rememberJob(result.job, action === "cancel" ? "Cancellation requested" : "Retry queued");
    await loadJobs();
  } catch (error) { notice(error.message, "warning"); }
});

$("#siteSearch").addEventListener("input", renderSites);
$("#refreshStats").addEventListener("click", async (event) => {
  try {
    await withButton(event.currentTarget, "Refreshing...", () => loadStats(true));
  } catch (error) { notice(error.message, "warning"); }
});
$("#websiteStats").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-inspect-stats]");
  if (!button) return;
  try {
    await withButton(button, "Loading...", () => loadSiteStats(button.dataset.inspectStats));
    $("#siteStatsDetail").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { notice(error.message, "warning"); }
});
$("#loadSiteStats").addEventListener("click", async (event) => {
  try {
    await withButton(event.currentTarget, "Loading...", () => loadSiteStats("", true));
  } catch (error) { notice(error.message, "warning"); }
});
$("#siteIpStats").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-ipinfo-lookup]");
  if (!button || !state.siteStats?.domain) return;
  try {
    const response = await withButton(button, "Looking up...", () => api("/api/stats/ipinfo/lookup", {
      method: "POST",
      body: JSON.stringify({ domain: state.siteStats.domain, ip: button.dataset.ipinfoLookup }),
    }));
    state.ipinfo[response.result.ip] = response.result;
    renderSiteStats();
  } catch (error) { notice(error.message, "warning"); }
});
$("#clearIpinfoCache").addEventListener("click", async (event) => {
  if (!confirm("Clear all cached IPinfo lookup results?")) return;
  try {
    await withButton(event.currentTarget, "Clearing...", () => api("/api/stats/ipinfo/cache", { method: "DELETE" }));
    state.ipinfo = {};
    renderSiteStats();
    notice("IPinfo cache cleared.");
  } catch (error) { notice(error.message, "warning"); }
});
$("#provisionForm").elements.create_update_dns.addEventListener("change", syncProvisionDnsOptions);
$("#provisionForm").elements.apply_dns_preset.addEventListener("change", syncProvisionDnsOptions);
$$('#provisionForm input[name="source_mode"]').forEach((input) => input.addEventListener("change", syncProvisionSourceMode));
$$('#provisionForm input[name="site_type"]').forEach((input) => input.addEventListener("change", syncProvisionSourceMode));
syncProvisionDnsOptions();
syncProvisionSourceMode();
$("#optimizeAllImages").addEventListener("click", async () => {
  try {
    const result = await api("/api/sites/images/optimize-all", { method: "POST" });
    rememberJob(result.job, "Image optimization queued");
  } catch (error) {
    notice(error.message, "warning");
  }
});
async function runSiteAction(domain, action) {
  if (action === "manage") {
    state.selectedDomain = domain;
    switchTab("integrations");
    return;
  }
  if (action === "optimize") {
    const result = await api("/api/sites/images/optimize", {
      method: "POST",
      body: JSON.stringify({ domain }),
    });
    rememberJob(result.job, `Image optimization queued for ${domain}`);
    return;
  }
  if (action === "backup") {
    const result = await api("/api/backups/site", { method: "POST", body: JSON.stringify({ domain }) });
    state.backupName = domain;
    rememberJob(result.job, `Backup queued for ${domain}`);
    return;
  }

  const site = state.sites.find((entry) => entry.host === domain);
  if (!site) throw new Error(`Website ${domain} is not available.`);
  if (action === "backup-schedule" || action === "image-schedule") {
    const images = action === "image-schedule";
    const enabled = images ? !site.state?.imageOptimizationEnabled : !site.state?.backupEnabled;
    await api("/api/site-state", {
      method: "PUT",
      body: JSON.stringify({
        domain,
        ...(images ? { image_optimization_enabled: enabled } : { backup_enabled: enabled }),
      }),
    });
    notice(`${images ? "Daily image optimization" : "Daily backup"} ${enabled ? "enabled" : "disabled"} for ${domain}.`);
    await loadData();
    return;
  }
  if (action === "purge") {
    await api("/api/site-state/purge", { method: "POST", body: JSON.stringify({ domain }) });
    notice("Site page cache purged.");
  } else {
    await api("/api/site-state", {
      method: "PUT",
      body: JSON.stringify({
        domain,
        ...(action === "fastcgi" ? { fastcgi_cache: !site.state?.fastcgiCache } : {}),
        ...(action === "redis" ? { redis: !site.state?.redis } : {}),
        ...(action === "opcache" ? { opcache: site.state?.opcache === false } : {}),
      }),
    });
    notice("Site cache settings updated.");
  }
  await loadData();
}

$("#sitesList").addEventListener("click", async (event) => {
  const manage = event.target.closest("[data-manage-site]");
  const fastcgi = event.target.closest("[data-toggle-fastcgi]");
  const redis = event.target.closest("[data-toggle-redis]");
  const opcache = event.target.closest("[data-toggle-opcache]");
  const purge = event.target.closest("[data-purge-cache]");
  const backup = event.target.closest("[data-backup-site]");
  const optimize = event.target.closest("[data-optimize-images]");
  const backupSchedule = event.target.closest("[data-toggle-backup]");
  const imageSchedule = event.target.closest("[data-toggle-image-optimization]");
  const button = manage || fastcgi || redis || opcache || purge || backup || optimize || backupSchedule || imageSchedule;
  if (!button) return;
  const action = manage ? "manage" : fastcgi ? "fastcgi" : redis ? "redis" : opcache ? "opcache" : purge ? "purge" : backup ? "backup" : optimize ? "optimize" : backupSchedule ? "backup-schedule" : "image-schedule";
  const domain = manage?.dataset.manageSite || fastcgi?.dataset.toggleFastcgi || redis?.dataset.toggleRedis || opcache?.dataset.toggleOpcache || purge?.dataset.purgeCache || backup?.dataset.backupSite || optimize?.dataset.optimizeImages || backupSchedule?.dataset.toggleBackup || imageSchedule.dataset.toggleImageOptimization;
  const pending = action === "backup" ? "Backing up..." : action === "optimize" ? "Optimizing..." : "Working...";
  try { await withButton(button, pending, () => runSiteAction(domain, action)); }
  catch (error) { notice(error.message, "warning"); }
});

$("#integrationDomain").addEventListener("change", async (event) => {
  state.selectedDomain = event.target.value;
  await refreshIntegrationView();
});
$("#securityDomain").addEventListener("change", async (event) => {
  state.selectedDomain = event.target.value;
  await loadSecurity().catch((error) => notice(error.message, "warning"));
});
$("#refreshSecurity").addEventListener("click", async (event) => {
  try { await withButton(event.currentTarget, "Refreshing...", loadSecurity); }
  catch (error) { notice(error.message, "warning"); }
});
$$('[data-security-preset]').forEach((button) => button.addEventListener("click", async (event) => {
  try {
    await withButton(event.currentTarget, "Applying...", () => api("/api/cloudflare/security/presets", {
      method: "POST",
      body: JSON.stringify({ domain: state.selectedDomain, preset: event.currentTarget.dataset.securityPreset }),
    }));
    notice("Cloudflare security preset applied.");
    await loadSecurity();
  } catch (error) { notice(error.message, "warning"); }
}));
$("#securityRules").addEventListener("change", async (event) => {
  const input = event.target.closest("[data-security-toggle]");
  if (!input) return;
  try {
    await api(`/api/cloudflare/security/rules/${encodeURIComponent(input.dataset.rulesetId)}/${encodeURIComponent(input.dataset.securityToggle)}`, {
      method: "PATCH",
      body: JSON.stringify({ domain: state.selectedDomain, enabled: input.checked }),
    });
    notice(`Cloudflare rule ${input.checked ? "enabled" : "disabled"}.`);
    await loadSecurity();
  } catch (error) {
    input.checked = !input.checked;
    notice(error.message, "warning");
  }
});
$("#securityRules").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-security-delete]");
  if (!button || !confirm("Remove this panel-managed Cloudflare rule?")) return;
  try {
    await withButton(button, "Removing...", () => api(
      `/api/cloudflare/security/rules/${encodeURIComponent(button.dataset.rulesetId)}/${encodeURIComponent(button.dataset.securityDelete)}?domain=${encodeURIComponent(state.selectedDomain)}`,
      { method: "DELETE" },
    ));
    notice("Cloudflare security rule removed.");
    await loadSecurity();
  } catch (error) { notice(error.message, "warning"); }
});
$("#loadDns").addEventListener("click", () => loadDns().catch((error) => notice(error.message, "warning")));
$("#refreshNpm").addEventListener("click", () => loadNpm().catch((error) => notice(error.message, "warning")));

$("#dnsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = formObject(event.currentTarget);
  body.domain = state.selectedDomain;
  const recordId = body.record_id;
  delete body.record_id;
  try {
    const url = recordId ? `/api/cloudflare/records/${encodeURIComponent(recordId)}` : "/api/cloudflare/records";
    await withButton(event.submitter, "Saving...", () => api(url, {
      method: recordId ? "PUT" : "POST",
      body: JSON.stringify(body),
    }));
    notice("DNS record saved.");
    resetDnsForm();
    await loadDns();
  } catch (error) { notice(error.message, "warning"); }
});

$("#dnsRecords").addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-dns]");
  if (editButton) {
    const record = state.dnsRecords.find((item) => item.id === editButton.dataset.editDns);
    if (!record) return;
    const form = $("#dnsForm");
    form.elements.record_id.value = record.id;
    form.elements.type.value = record.type;
    form.elements.name.value = record.name;
    form.elements.content.value = record.content;
    form.elements.ttl.value = record.ttl || 1;
    form.elements.priority.value = record.priority || 10;
    form.elements.proxied.checked = Boolean(record.proxied);
    $("#saveDnsRecord").textContent = "Update record";
    $("#cancelDnsEdit").classList.remove("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  const button = event.target.closest("[data-delete-dns]");
  if (!button || !confirm("Delete this DNS record? This cannot be undone.")) return;
  try {
    await api(`/api/cloudflare/records/${encodeURIComponent(button.dataset.deleteDns)}?domain=${encodeURIComponent(state.selectedDomain)}`, { method: "DELETE" });
    notice("DNS record deleted.");
    await loadDns();
  } catch (error) { notice(error.message, "warning"); }
});

$("#cancelDnsEdit").addEventListener("click", resetDnsForm);

$("#applyDnsPreset").addEventListener("click", async (event) => {
  const presetId = $("#dnsPresetSelect").value;
  if (!presetId) return notice("Select a DNS preset first.", "warning");
  try {
    const result = await withButton(event.currentTarget, "Applying...", () => api(
      `/api/dns-presets/${encodeURIComponent(presetId)}/apply`,
      { method: "POST", body: JSON.stringify({ domain: state.selectedDomain }) },
    ));
    notice(`${result.count} preset record${result.count === 1 ? "" : "s"} added to ${state.selectedDomain}.`);
    await loadDns();
  } catch (error) { notice(error.message, "warning"); }
});

async function ensureNpm(issueSsl) {
  const domain = state.selectedDomain;
  if (!domain) return;
  await api("/api/npm/hosts/ensure", {
    method: "POST",
    body: JSON.stringify({ domain, add_www: true, issue_ssl: issueSsl }),
  });
  await loadNpm();
}

$("#ensureNpmHost").addEventListener("click", async (event) => {
  try { await withButton(event.currentTarget, "Working...", () => ensureNpm(false)); notice("NPM host is ready."); }
  catch (error) { notice(error.message, "warning"); }
});
$("#issueNpmSsl").addEventListener("click", async (event) => {
  try { await withButton(event.currentTarget, "Issuing...", () => ensureNpm(true)); notice("SSL certificate issued."); }
  catch (error) { notice(error.message, "warning"); }
});
$("#renewNpmSsl").addEventListener("click", async (event) => {
  const host = selectedNpmHost();
  if (!host?.certificate_id) return notice("This host has no certificate to renew.", "warning");
  try {
    await withButton(event.currentTarget, "Renewing...", () => api("/api/npm/certificates/renew", {
      method: "POST",
      body: JSON.stringify({ certificate_id: host.certificate_id }),
    }));
    notice("Certificate renewed.");
    await loadNpm();
  } catch (error) { notice(error.message, "warning"); }
});

$("#provisionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (provisionInFlight) return notice("An import or provisioning operation is already running.", "warning");
  const body = formObject(event.currentTarget);
  const importing = body.source_mode === "import";
  const wordpress = body.site_type === "wordpress";
  body.plugin_packages = $$('[data-package-choice="plugins"]:checked').map((input) => input.value);
  body.theme_packages = $$('[data-package-choice="themes"]:checked').map((input) => input.value);
  if (body.create_update_dns && !body.dns_ip.trim()) return notice("Enter or select the server IPv4 address.", "warning");
  if (body.apply_dns_preset && !body.dns_preset_id) return notice("Select the DNS preset to add.", "warning");
  const websiteArchive = $("#provisionWebsiteArchive").files[0];
  const databaseDump = $("#provisionDatabaseDump").files[0];
  if (importing && !websiteArchive) return notice("Select the website archive.", "warning");
  if (importing && wordpress && !databaseDump) return notice("Select the WordPress database dump.", "warning");
  const resultPanel = $("#provisionResult");
  const importProgress = $("#provisionImportProgress");
  const submitButton = event.submitter || $("#provisionSubmit");
  resultPanel.classList.add("hidden");
  provisionInFlight = true;
  try {
    const result = await withButton(submitButton, importing ? "Uploading files..." : "Creating website...", async () => {
      if (importing) {
        body.import_upload_id = provisionUploadId();
        await uploadProvisionImport(websiteArchive, body.import_upload_id, "website", (loaded, total) => {
          importProgress.textContent = uploadProgress("Uploading website archive", loaded, total);
        });
        if (wordpress) {
          await uploadProvisionImport(databaseDump, body.import_upload_id, "database", (loaded, total) => {
            importProgress.textContent = uploadProgress("Website archive uploaded. Uploading database", loaded, total);
          });
        }
        submitButton.textContent = "Queuing import...";
        importProgress.textContent = "Uploads complete. The staged files are ready for the background job.";
      }
      return api("/api/provision", { method: "POST", body: JSON.stringify(body) });
    });
    resultPanel.innerHTML = `<h3>Provisioning queued</h3><p>Job ${escapeHtml(result.job.id.slice(0, 8))} will continue without keeping this browser request open. Progress, warnings, cancellation, and one-time WordPress credentials are available in Jobs.</p>`;
    resultPanel.classList.remove("hidden");
    importProgress.textContent = importing ? "Import queued. Uploaded staging is retained until the job succeeds." : "Provisioning queued.";
    rememberJob(result.job, importing ? "Website import queued" : "Website provisioning queued");
    switchTab("jobs");
  } catch (error) {
    resultPanel.innerHTML = `<h3>Provisioning stopped</h3><p>${escapeHtml(error.message)}</p><pre>${escapeHtml(error.details || "")}</pre>`;
    resultPanel.classList.remove("hidden");
    notice("Provisioning did not complete. Review the result before retrying.", "warning");
  } finally {
    provisionInFlight = false;
  }
});

$("#sitesList").addEventListener("change", async (event) => {
  const actionSelect = event.target.closest("[data-site-action]");
  if (actionSelect) {
    if (!actionSelect.value) return;
    actionSelect.disabled = true;
    try { await runSiteAction(actionSelect.dataset.siteAction, actionSelect.value); }
    catch (error) { notice(error.message, "warning"); }
    finally {
      actionSelect.value = "";
      actionSelect.disabled = false;
    }
    return;
  }
  const tier = event.target.closest("[data-site-pool-tier]");
  if (tier) {
    tier.disabled = true;
    try {
      await api("/api/pools/upsert", {
        method: "POST",
        body: JSON.stringify({
          name: tier.dataset.poolName,
          port: Number(tier.dataset.poolPort),
          tier: tier.value,
          settings: {},
        }),
      });
      await api("/api/validate", { method: "POST" });
      await api("/api/actions/reload_php", { method: "POST" });
      notice(`${tier.dataset.sitePoolTier} now uses the ${tier.value} PHP profile.`);
      await loadData();
    } catch (error) {
      notice(error.message, "warning");
      await loadData();
    } finally {
      tier.disabled = false;
    }
    return;
  }
});

$("#imageOptimizationSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await withButton(event.submitter, "Saving...", () => api("/api/sites/images/settings", {
      method: "PUT",
      body: JSON.stringify(formObject(event.currentTarget)),
    }));
    state.imageOptimization = { ...(state.imageOptimization || {}), settings: data.settings };
    notice("Automatic image optimization schedule saved.");
    await loadData();
  } catch (error) {
    notice(error.message, "warning");
  }
});

$("#refreshMaintenance").addEventListener("click", async (event) => {
  try { await withButton(event.currentTarget, "Refreshing...", loadMaintenance); }
  catch (error) { notice(error.message, "warning"); }
});

$("#maintenanceSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const operations = $$('[name="scheduled_operation"]:checked').map((input) => input.value);
  if (!operations.length) return notice("Select at least one scheduled maintenance operation.", "warning");
  try {
    const data = await withButton(event.submitter, "Saving...", () => api("/api/maintenance/settings", {
      method: "PUT",
      body: JSON.stringify({
        enabled: event.currentTarget.elements.enabled.checked,
        weekday: Number(event.currentTarget.elements.weekday.value),
        schedule_time: event.currentTarget.elements.schedule_time.value,
        operations,
      }),
    }));
    state.maintenance = { ...(state.maintenance || {}), settings: data.settings };
    renderMaintenance();
    notice("WordPress maintenance schedule saved.");
  } catch (error) { notice(error.message, "warning"); }
});

$("#selectAllMaintenance").addEventListener("click", () => {
  $$("[data-maintenance-site]").forEach((input) => { input.checked = true; });
});

$("#clearMaintenanceSelection").addEventListener("click", () => {
  $$("[data-maintenance-site]").forEach((input) => { input.checked = false; });
});

$("#maintenanceSites").addEventListener("change", async (event) => {
  const checkbox = event.target.closest("[data-maintenance-weekly]");
  if (!checkbox) return;
  checkbox.disabled = true;
  try {
    await api("/api/site-state", {
      method: "PUT",
      body: JSON.stringify({ domain: checkbox.dataset.maintenanceWeekly, maintenance_enabled: checkbox.checked }),
    });
    const site = state.sites.find((entry) => entry.host === checkbox.dataset.maintenanceWeekly);
    if (site) site.state = { ...(site.state || {}), maintenanceEnabled: checkbox.checked };
    notice(`Weekly maintenance ${checkbox.checked ? "enabled" : "disabled"} for ${checkbox.dataset.maintenanceWeekly}.`);
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    notice(error.message, "warning");
  } finally { checkbox.disabled = false; }
});

$("#runMaintenance").addEventListener("click", async (event) => {
  const domains = $$("[data-maintenance-site]:checked").map((input) => input.value);
  const operations = $$('[name="manual_operation"]:checked').map((input) => input.value);
  if (!domains.length) return notice("Select at least one WordPress website.", "warning");
  if (!operations.length) return notice("Select at least one maintenance operation.", "warning");
  try {
    const data = await withButton(event.currentTarget, "Starting...", () => api("/api/maintenance/run", {
      method: "POST",
      body: JSON.stringify({ domains, operations }),
    }));
    rememberJob(data.job, "WordPress maintenance queued");
  } catch (error) { notice(error.message, "warning"); }
});

$("#backupDomain").addEventListener("change", async (event) => {
  state.backupName = event.target.value;
  try { await loadBackupView(); } catch (error) { notice(error.message, "warning"); }
});

$("#removalDomain").addEventListener("change", async () => {
  try { await loadRemovalPlan(); } catch (error) { notice(error.message, "warning"); }
});

$("#refreshRemovalPlan").addEventListener("click", async (event) => {
  try { await withButton(event.currentTarget, "Inspecting...", loadRemovalPlan); }
  catch (error) { notice(error.message, "warning"); }
});

$("#siteRemovalForm").addEventListener("change", (event) => {
  if (event.target.name === "final_backup" && event.target.checked) event.currentTarget.elements.backups.checked = false;
  if (event.target.name === "backups" && event.target.checked) event.currentTarget.elements.final_backup.checked = false;
  if (event.target.name === "runtime" && !event.target.checked) event.currentTarget.elements.pool.checked = false;
  if (event.target.name === "npm_host" && !event.target.checked) event.currentTarget.elements.npm_certificate.checked = false;
});

$("#siteRemovalForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const domain = $("#removalDomain").value;
  const body = formObject(event.currentTarget);
  if (body.confirm_domain.trim().toLowerCase() !== domain) return notice(`Type ${domain} exactly to confirm deletion.`, "warning");
  if (!confirm(`Permanently delete the selected resources for ${domain}?`)) return;
  try {
    const result = await withButton(event.submitter, "Queueing...", () => api("/api/site-removal", {
      method: "POST",
      body: JSON.stringify({ domain, ...body }),
    }));
    $("#removalResult").innerHTML = `<h3>${escapeHtml(domain)} removal queued</h3><p>Follow progress and results in Jobs.</p>`;
    $("#removalResult").classList.remove("hidden");
    rememberJob(result.job, `Website deletion queued for ${domain}`);
    state.removalPlan = null;
    switchTab("jobs");
  } catch (error) { notice(error.message, "warning"); }
});

$("#refreshBackups").addEventListener("click", async (event) => {
  try { await withButton(event.currentTarget, "Refreshing...", loadBackupView); }
  catch (error) { notice(error.message, "warning"); }
});

$("#backupSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await withButton(event.submitter, "Saving...", () => api("/api/backups/settings", {
      method: "PUT",
      body: JSON.stringify(formObject(event.currentTarget)),
    }));
    notice("Backup schedule saved.");
    await loadBackupView();
  } catch (error) { notice(error.message, "warning"); }
});

$("#backupAppData").addEventListener("click", async (event) => {
  try {
    const result = await withButton(event.currentTarget, "Queuing...", () => api("/api/backups/app-data", { method: "POST" }));
    state.backupName = "app-data";
    rememberJob(result.job, "Application-data backup queued");
  } catch (error) { notice(error.message, "warning"); }
});

async function startWebsiteBatch(scope, button) {
  const all = scope === "all";
  if (all && !confirm("Back up every configured website now, including sites without the Daily checkbox?")) return;
  try {
    const result = await withButton(button, "Starting...", () => api("/api/backups/sites", {
      method: "POST",
      body: JSON.stringify({ scope }),
    }));
    rememberJob(result.job, all ? "All-website backup queued" : "Enabled-website backup queued");
  } catch (error) { notice(error.message, "warning"); }
}

$("#backupEnabledSites").addEventListener("click", (event) => startWebsiteBatch("enabled", event.currentTarget));
$("#backupAllSites").addEventListener("click", (event) => startWebsiteBatch("all", event.currentTarget));

$("#backupHistory").addEventListener("click", async (event) => {
  const restoreButton = event.target.closest("[data-restore-backup]");
  if (restoreButton) {
    const message = `Restore ${state.backupName} from ${restoreButton.dataset.restoreBackup}?\n\nThe panel will create a safety backup first, then replace the website files and database.`;
    if (!confirm(message)) return;
    try {
      const result = await withButton(restoreButton, "Restoring...", () => api("/api/backups/restore", {
        method: "POST",
        body: JSON.stringify({
          domain: state.backupName,
          backup_id: restoreButton.dataset.restoreBackup,
        }),
      }));
      rememberJob(result.job, `Restore queued for ${state.backupName}`);
    } catch (error) { notice(error.message, "warning"); }
    return;
  }
  const button = event.target.closest("[data-delete-backup]");
  if (!button || !confirm("Delete this complete backup set?")) return;
  try {
    await withButton(button, "Deleting...", () => api(
      `/api/backups/${encodeURIComponent(state.backupName)}/${encodeURIComponent(button.dataset.deleteBackup)}`,
      { method: "DELETE" },
    ));
    notice("Backup set deleted.");
    await loadBackupView();
  } catch (error) { notice(error.message, "warning"); }
});

$("#addDnsPresetRecord").addEventListener("click", () => {
  const form = $("#dnsPresetForm");
  try {
    state.dnsPresetDraft.push(presetRecordFromForm(form));
    renderDnsPresetDraft();
    form.elements.content_template.value = "";
  } catch (error) { notice(error.message, "warning"); }
});

$("#dnsPresetDraft").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-preset-record]");
  if (!button) return;
  state.dnsPresetDraft = state.dnsPresetDraft.filter((record) => record.id !== button.dataset.removePresetRecord);
  renderDnsPresetDraft();
});

$("#dnsPresetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.dnsPresetDraft.length) return notice("Add at least one record to the preset.", "warning");
  const payload = {
    id: event.currentTarget.elements.id.value,
    label: event.currentTarget.elements.label.value,
    records: state.dnsPresetDraft,
  };
  try {
    await withButton(event.submitter, "Saving...", () => api("/api/dns-presets", {
      method: "POST",
      body: JSON.stringify(payload),
    }));
    resetDnsPresetForm();
    notice("DNS preset set saved.");
    await loadDnsPresets();
  } catch (error) { notice(error.message, "warning"); }
});

$("#dnsPresetList").addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-dns-preset]");
  if (editButton) {
    const preset = state.dnsPresets.find((item) => item.id === editButton.dataset.editDnsPreset);
    if (!preset) return;
    const form = $("#dnsPresetForm");
    form.elements.id.value = preset.id;
    form.elements.label.value = preset.label;
    state.dnsPresetDraft = (preset.records || []).map((record) => ({
      id: record.id,
      type: record.type,
      name_template: record.nameTemplate,
      content_template: record.contentTemplate,
      ttl: record.ttl,
      priority: record.priority || 10,
      proxied: record.proxied,
    }));
    renderDnsPresetDraft();
    $("#cancelDnsPresetEdit").classList.remove("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  const deleteButton = event.target.closest("[data-delete-dns-preset]");
  if (!deleteButton || !confirm("Delete this global DNS preset?")) return;
  try {
    await api(`/api/dns-presets/${encodeURIComponent(deleteButton.dataset.deleteDnsPreset)}`, { method: "DELETE" });
    notice("DNS preset deleted.");
    await loadDnsPresets();
  } catch (error) { notice(error.message, "warning"); }
});

$("#cancelDnsPresetEdit").addEventListener("click", resetDnsPresetForm);

$$('[data-package-upload]').forEach((form) => form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const kind = form.dataset.packageUpload;
  const files = [...form.elements.package.files];
  if (!files.length) return;
  try {
    await withButton(event.submitter, "Uploading...", async () => {
      for (const file of files) {
        await api(`/api/wordpress-packages/${kind}?filename=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { "Content-Type": "application/zip" },
          body: file,
        });
      }
    });
    form.reset();
    await loadWordPressPackages();
    notice(`${files.length} ${kind === "plugins" ? "plugin" : "theme"} package${files.length === 1 ? "" : "s"} uploaded.`);
  } catch (error) { notice(error.message, "warning"); }
}));

$(".package-library").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-package]");
  if (!button || !confirm("Delete this installation package from the library?")) return;
  try {
    await withButton(button, "Deleting...", () => api(
      `/api/wordpress-packages/${button.dataset.packageKind}/${encodeURIComponent(button.dataset.deletePackage)}`,
      { method: "DELETE" },
    ));
    await loadWordPressPackages();
    notice("Installation package deleted.");
  } catch (error) { notice(error.message, "warning"); }
});

$("#saveCloudflareIps").addEventListener("click", async (event) => {
  const addresses = $("#cloudflareIpForm").elements.addresses.value
    .split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  try {
    const result = await withButton(event.currentTarget, "Saving...", () => api("/api/cloudflare/ip-addresses", {
      method: "PUT",
      body: JSON.stringify({ addresses }),
    }));
    state.cloudflareIps = result.addresses;
    renderCloudflareIps();
    notice("Cloudflare server IP list saved.");
  } catch (error) { notice(error.message, "warning"); }
});

$("#cloudflareIpForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = formObject(event.currentTarget);
  if (!confirm(`Replace every Cloudflare A record pointing to ${body.from_ip} with ${body.to_ip} across all accessible zones?`)) return;
  try {
    const result = await withButton(event.submitter, "Replacing...", () => api("/api/cloudflare/replace-a-records", {
      method: "POST",
      body: JSON.stringify(body),
    }));
    $("#cloudflareIpResult").textContent = [
      `Zones checked: ${result.zonesChecked}`,
      `A records changed: ${result.changed}`,
      ...(result.records || []).slice(0, 20).map((record) => `${record.name}: ${record.from} → ${record.to}`),
      result.changed > 20 ? `...and ${result.changed - 20} more` : "",
    ].filter(Boolean).join("\n");
    notice(`${result.changed} Cloudflare A record${result.changed === 1 ? "" : "s"} updated.`);
    await loadDns();
  } catch (error) { notice(error.message, "warning"); }
});

$("#savePools").addEventListener("click", async (event) => {
  const pools = $$("#poolsTable tr").map((row) => ({
    name: row.querySelector('[data-pool-field="name"]').value,
    port: Number(row.querySelector('[data-pool-field="port"]').value),
    tier: row.querySelector('[data-pool-field="tier"]').value,
    settings: {},
  }));
  try {
    await withButton(event.currentTarget, "Saving...", () => api("/api/pools/bulk-upsert", { method: "POST", body: JSON.stringify({ pools }) }));
    await api("/api/validate", { method: "POST" });
    notice("PHP pools saved and validated.");
    await loadData();
  } catch (error) { notice(error.message, "warning"); }
});

$("#saveHosts").addEventListener("click", async (event) => {
  const hosts = $$("#hostsTable tr").map((row) => ({
    host: row.querySelector('[data-host-field="host"]').value,
    root: row.querySelector('[data-host-field="root"]').value,
    pool_name: row.querySelector('[data-host-field="pool_name"]').value,
    canonical_to: row.querySelector('[data-host-field="canonical_to"]').value,
    add_www_alias: row.querySelector('[data-host-field="add_www_alias"]').checked,
  }));
  try {
    await withButton(event.currentTarget, "Saving...", () => api("/api/hosts/bulk-upsert", { method: "POST", body: JSON.stringify({ hosts }) }));
    await api("/api/validate", { method: "POST" });
    notice("Routes saved and validated.");
    await loadData();
  } catch (error) { notice(error.message, "warning"); }
});

const runtimeActions = {
  validateConfig: ["/api/validate", "Validating...", "Configuration is valid."],
  reloadNginx: ["/api/actions/reload_nginx", "Reloading...", "nginx reloaded."],
  reloadPhp: ["/api/actions/reload_php", "Reloading...", "PHP-FPM reloaded."],
  clearOpcache: ["/api/actions/clear_opcache", "Clearing...", "OPcache cleared."],
};
for (const [id, [url, pending, complete]] of Object.entries(runtimeActions)) {
  $(`#${id}`).addEventListener("click", async (event) => {
    try { await withButton(event.currentTarget, pending, () => api(url, { method: "POST" })); notice(complete); await loadLogs(); }
    catch (error) { notice(error.message, "warning"); }
  });
}
$("#refreshLogs").addEventListener("click", loadLogs);

$("#integrationSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await withButton(event.submitter, "Saving...", () => api("/api/settings/integrations", {
      method: "PUT",
      body: JSON.stringify(formObject(event.currentTarget)),
    }));
    notice("Integration settings saved.");
    await loadData();
    await loadIntegrationSettings();
  } catch (error) {
    notice(error.message, "warning");
  }
});

$("#notificationSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await withButton(event.submitter, "Saving...", () => api("/api/settings/notifications", {
      method: "PUT",
      body: JSON.stringify(formObject(event.currentTarget)),
    }));
    notice("Notification settings saved.");
    await loadIntegrationSettings();
  } catch (error) {
    notice(error.message, "warning");
  }
});

$("#healthSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = {
    enabled: form.elements.enabled.checked,
    intervalMinutes: Number(form.elements.intervalMinutes.value),
    diskWarningPercent: Number(form.elements.diskWarningPercent.value),
    diskCriticalPercent: Number(form.elements.diskCriticalPercent.value),
    certificateWarningDays: Number(form.elements.certificateWarningDays.value),
    certificateCriticalDays: Number(form.elements.certificateCriticalDays.value),
    opcacheWarningPercent: Number(form.elements.opcacheWarningPercent.value),
    requiredContainers: form.elements.requiredContainers.value,
    publicCheckTimeoutSeconds: Number(form.elements.publicCheckTimeoutSeconds.value),
    publicHosts: form.elements.publicHosts.value,
  };
  try {
    const data = await withButton(event.submitter, "Saving...", () => api("/api/health/settings", { method: "PUT", body: JSON.stringify(body) }));
    state.health = data.health;
    notice("Health settings saved.");
  } catch (error) { notice(error.message, "warning"); }
});

$("#runHealthCheck").addEventListener("click", async (event) => {
  try {
    const data = await withButton(event.currentTarget, "Checking...", () => api("/api/health/run", { method: "POST" }));
    state.health = data.health;
    renderHealth();
    notice(state.health.summary.healthy ? "Health check completed with no incidents." : "Health check completed. Review active incidents.", state.health.summary.healthy ? "success" : "warning");
  } catch (error) { notice(error.message, "warning"); }
});

$$('[data-test-notification]').forEach((button) => button.addEventListener("click", async () => {
  try {
    const result = await withButton(button, "Sending...", () => api("/api/settings/notifications/test", {
      method: "POST",
      body: JSON.stringify({ channel: button.dataset.testNotification }),
    }));
    notice(result.message);
  } catch (error) {
    notice(error.message, "warning");
  }
}));

$("#performanceSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const number = (name) => Number(form.elements[name].value);
  const body = {
    php: {
      memoryLimitMb: number("phpMemoryLimitMb"),
      maxExecutionSeconds: number("phpMaxExecutionSeconds"),
    },
    opcache: {
      memoryMb: number("opcacheMemoryMb"),
      internedStringsMb: number("opcacheInternedStringsMb"),
      maxFiles: number("opcacheMaxFiles"),
      revalidateSeconds: number("opcacheRevalidateSeconds"),
      validateTimestamps: form.elements.opcacheValidateTimestamps.checked,
    },
    fastcgi: {
      keysZoneMb: number("fastcgiKeysZoneMb"),
      maxSizeGb: number("fastcgiMaxSizeGb"),
      inactiveMinutes: number("fastcgiInactiveMinutes"),
      validMinutes: number("fastcgiValidMinutes"),
      readTimeoutSeconds: number("fastcgiReadTimeoutSeconds"),
      cacheLock: form.elements.fastcgiCacheLock.checked,
    },
    redis: {
      maxMemoryMb: number("redisMaxMemoryMb"),
      policy: form.elements.redisPolicy.value,
    },
    mysql: {
      bufferPoolMb: number("mysqlBufferPoolMb"),
      maxConnections: number("mysqlMaxConnections"),
      redoLogCapacityMb: number("mysqlRedoLogCapacityMb"),
    },
  };
  try {
    await withButton(event.submitter, "Applying...", () => api("/api/settings/performance", {
      method: "PUT",
      body: JSON.stringify(body),
    }));
    notice("Performance settings applied.");
    await loadIntegrationSettings();
  } catch (error) {
    notice(error.message, "warning");
  }
});

$$("[data-test-integration]").forEach((button) => button.addEventListener("click", async () => {
  const target = button.dataset.testIntegration;
  try {
    const result = await withButton(button, "Testing...", () => api("/api/settings/test", {
      method: "POST",
      body: JSON.stringify({ target }),
    }));
    notice(result.message);
  } catch (error) {
    notice(`${target}: ${error.message}`, "warning");
  }
}));

$("#accountForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await withButton(event.submitter, "Saving...", () => api("/api/auth/account", {
      method: "PUT",
      body: JSON.stringify(formObject(event.currentTarget)),
    }));
    state.csrf = result.csrf;
    state.user = result.email;
    $("#currentUser").textContent = result.email;
    $("#accountEmail").value = result.email;
    event.currentTarget.reset();
    $("#accountEmail").value = result.email;
    notice("Account updated.");
  } catch (error) { notice(error.message, "warning"); }
});

(async () => {
  try {
    const session = await api("/api/auth/status");
    if (!session.authenticated) return showLogin();
    showApp(session);
    await loadData();
  } catch {
    showLogin();
  }
})();
