const state = {
  csrf: "",
  user: "",
  status: null,
  sites: [],
  pools: [],
  tiers: {},
  npmHosts: [],
  selectedDomain: "",
};

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
    output[element.name] = element.type === "checkbox" ? element.checked : element.value;
  }
  return output;
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
  $$("[data-tab-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.tabPanel !== name));
  $$("[data-tab-link]").forEach((button) => button.classList.toggle("active", button.dataset.tabLink === name));
  const titles = { sites: "Sites", provision: "Provision", integrations: "DNS & SSL", runtime: "Runtime", settings: "Settings", account: "Account" };
  $("#pageTitle").textContent = titles[name] || "Hosting Control";
  if (name === "integrations") refreshIntegrationView();
  if (name === "runtime") loadLogs();
  if (name === "settings") loadIntegrationSettings();
}

function primarySites() {
  return state.sites.filter((site) => !site.isWwwAlias);
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
  enabled.push("MySQL");
  $("#integrationSummary").textContent = `${enabled.join(" · ")} ready`;
}

function renderSites() {
  const query = $("#siteSearch").value.trim().toLowerCase();
  const sites = primarySites().filter((site) => site.host.toLowerCase().includes(query));
  const container = $("#sitesList");
  if (!sites.length) {
    container.innerHTML = '<div class="panel muted">No matching websites.</div>';
    return;
  }
  container.innerHTML = sites.map((site) => `
    <article class="site-row">
      <div><h3>${escapeHtml(site.host)}</h3><p>${escapeHtml(site.root)}</p></div>
      <div><strong>${escapeHtml(site.poolName || "No pool")}</strong><p>Port ${escapeHtml(site.port || "—")} · ${escapeHtml(site.poolTier || "custom")}</p></div>
      <div class="site-flags">
        <span class="badge ${site.state?.fastcgiCache ? "on" : ""}">FastCGI ${site.state?.fastcgiCache ? "on" : "off"}</span>
        <span class="badge ${site.state?.redis ? "on" : ""}">Redis ${site.state?.redis ? "on" : "off"}</span>
      </div>
      <div class="button-row">
        <button class="secondary" data-toggle-fastcgi="${escapeHtml(site.host)}">${site.state?.fastcgiCache ? "Disable" : "Enable"} FastCGI</button>
        <button class="secondary" data-toggle-redis="${escapeHtml(site.host)}">${site.state?.redis ? "Disable" : "Enable"} Redis</button>
        <button class="secondary" data-purge-cache="${escapeHtml(site.host)}">Purge</button>
        <button class="secondary" data-manage-site="${escapeHtml(site.host)}">DNS &amp; SSL</button>
      </div>
    </article>
  `).join("");
}

function renderDomainOptions() {
  const domains = primarySites().map((site) => site.host);
  if (!state.selectedDomain || !domains.includes(state.selectedDomain)) state.selectedDomain = domains[0] || "";
  $("#integrationDomain").innerHTML = domains.map((domain) =>
    `<option value="${escapeHtml(domain)}" ${domain === state.selectedDomain ? "selected" : ""}>${escapeHtml(domain)}</option>`
  ).join("");
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
      <td><input data-host-field="add_www_alias" type="checkbox" ${!site.host.startsWith("www.") && state.sites.some((entry) => entry.host === `www.${site.host}` && entry.canonicalTo === site.host) ? "checked" : ""} /></td>
    </tr>
  `).join("");
}

async function loadData() {
  const [status, siteData, poolData, presetData] = await Promise.all([
    api("/api/status"),
    api("/api/sites"),
    api("/api/pools"),
    api("/api/pool-presets"),
  ]);
  state.status = status;
  state.sites = siteData.sites || [];
  state.pools = poolData.pools || [];
  state.tiers = presetData.tiers || {};
  $("#provisionTier").innerHTML = Object.keys(state.tiers).map((tier) => `<option value="${escapeHtml(tier)}">${escapeHtml(tier)}</option>`).join("");
  renderSummary();
  renderSites();
  renderDomainOptions();
  renderPools();
  renderHosts();
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
  $("#dnsZone").textContent = `Zone: ${data.zone.name}`;
  const records = data.records || [];
  $("#dnsRecords").className = records.length ? "rows" : "rows empty";
  $("#dnsRecords").innerHTML = records.length ? records.map((record) => `
    <div class="data-row">
      <strong>${escapeHtml(record.type)}</strong>
      <span>${escapeHtml(record.name)}</span>
      <code>${escapeHtml(record.content)}</code>
      <button class="secondary" data-delete-dns="${escapeHtml(record.id)}">Delete</button>
    </div>
  `).join("") : "No records found for this exact hostname.";
  $("#dnsForm [name=name]").value = domain;
}

async function refreshIntegrationView() {
  renderDomainOptions();
  await Promise.allSettled([loadNpm(), loadDns()]);
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
    const settings = await api("/api/settings/integrations");
    const form = $("#integrationSettingsForm");
    form.elements.npmApiUrl.value = settings.npmApiUrl || "";
    form.elements.npmIdentity.value = settings.npmIdentity || "";
    form.elements.npmSecret.value = "";
    form.elements.npmSecret.placeholder = settings.npmSecretConfigured ? "Saved password configured" : "Enter NPM password";
    form.elements.cloudflareToken.value = "";
    form.elements.cloudflareToken.placeholder = settings.cloudflareTokenConfigured ? "Saved token configured" : "Enter Cloudflare token";
    form.elements.mysqlContainer.value = settings.mysqlContainer || "mysql-db";
    form.elements.mysqlSitePrefix.value = settings.mysqlSitePrefix || "yogali00_";
    form.elements.clearNpmSecret.checked = false;
    form.elements.clearCloudflareToken.checked = false;
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

$("#siteSearch").addEventListener("input", renderSites);
$("#sitesList").addEventListener("click", (event) => {
  const manage = event.target.closest("[data-manage-site]");
  if (manage) {
    state.selectedDomain = manage.dataset.manageSite;
    switchTab("integrations");
    return;
  }
  const fastcgi = event.target.closest("[data-toggle-fastcgi]");
  const redis = event.target.closest("[data-toggle-redis]");
  const purge = event.target.closest("[data-purge-cache]");
  const domain = fastcgi?.dataset.toggleFastcgi || redis?.dataset.toggleRedis || purge?.dataset.purgeCache;
  if (!domain) return;
  const site = state.sites.find((entry) => entry.host === domain);
  const request = purge
    ? api("/api/site-state/purge", { method: "POST", body: JSON.stringify({ domain }) })
    : api("/api/site-state", {
        method: "PUT",
        body: JSON.stringify({
          domain,
          ...(fastcgi ? { fastcgi_cache: !site.state?.fastcgiCache } : {}),
          ...(redis ? { redis: !site.state?.redis } : {}),
        }),
      });
  withButton(event.target.closest("button"), "Working...", () => request)
    .then(async () => {
      notice(purge ? "Site page cache purged." : "Site cache settings updated.");
      await loadData();
    })
    .catch((error) => notice(error.message, "warning"));
});

$("#integrationDomain").addEventListener("change", async (event) => {
  state.selectedDomain = event.target.value;
  await refreshIntegrationView();
});
$("#loadDns").addEventListener("click", () => loadDns().catch((error) => notice(error.message, "warning")));
$("#refreshNpm").addEventListener("click", () => loadNpm().catch((error) => notice(error.message, "warning")));

$("#dnsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = formObject(event.currentTarget);
  body.domain = state.selectedDomain;
  try {
    await withButton(event.submitter, "Saving...", () => api("/api/cloudflare/records", { method: "POST", body: JSON.stringify(body) }));
    notice("DNS record saved.");
    await loadDns();
  } catch (error) { notice(error.message, "warning"); }
});

$("#dnsRecords").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-dns]");
  if (!button || !confirm("Delete this DNS record?")) return;
  try {
    await api(`/api/cloudflare/records/${encodeURIComponent(button.dataset.deleteDns)}?domain=${encodeURIComponent(state.selectedDomain)}`, { method: "DELETE" });
    notice("DNS record deleted.");
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
  const body = formObject(event.currentTarget);
  const resultPanel = $("#provisionResult");
  resultPanel.classList.add("hidden");
  try {
    const result = await withButton(event.submitter, "Creating website...", () => api("/api/provision", {
      method: "POST",
      body: JSON.stringify(body),
    }));
    resultPanel.innerHTML = `
      <h3>${escapeHtml(result.domain)} created</h3>
      <p>Database and WordPress credentials are shown once. Store them securely.</p>
      <pre>Database: ${escapeHtml(result.database.name)}
Database user: ${escapeHtml(result.database.user)}
Database password: ${escapeHtml(result.database.password)}

WordPress user: ${escapeHtml(result.wordpress.adminUser)}
WordPress password: ${escapeHtml(result.wordpress.adminPassword)}
WordPress email: ${escapeHtml(result.wordpress.adminEmail)}</pre>
      <p>${result.steps.map((step) => `${escapeHtml(step.name)}: ${escapeHtml(step.status)}${step.message ? ` (${escapeHtml(step.message)})` : ""}`).join(" · ")}</p>
    `;
    resultPanel.classList.remove("hidden");
    notice("Website provisioning completed.");
    await loadData();
  } catch (error) {
    resultPanel.innerHTML = `<h3>Provisioning stopped</h3><p>${escapeHtml(error.message)}</p><pre>${escapeHtml(error.details || "")}</pre>`;
    resultPanel.classList.remove("hidden");
    notice("Provisioning did not complete. Review the result before retrying.", "warning");
  }
});

$("#sitesList").addEventListener("change", () => {});

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
