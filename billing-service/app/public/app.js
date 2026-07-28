const state = {
  csrf: "",
  email: "",
  csv: "",
  fingerprint: "",
  restoreId: "",
  view: "overview",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (state.csrf && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = state.csrf;
  const response = await fetch(path, { ...options, method, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `HTTP ${response.status}`);
    error.details = body.details;
    throw error;
  }
  return body;
}

function notice(message, error = false) {
  const element = $("#globalNotice");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.hidden = false;
  window.setTimeout(() => { element.hidden = true; }, 7000);
}

async function busy(button, operation) {
  const previous = button.textContent;
  button.disabled = true;
  try {
    return await operation();
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function showView(view) {
  state.view = view;
  $$("[data-section]").forEach((section) => { section.hidden = section.dataset.section !== view; });
  $$("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("#mobileNav").value = view;
  if (view === "overview") loadOverview();
  if (view === "payments") loadPayments();
  if (view === "reminders") loadReminders();
  if (view === "backups") loadBackups();
  if (view === "audit") loadAudit();
}

function formatDate(value) {
  if (!value) return "Not set";
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(parsed.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
}

function formatMoney(minor, currency) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(Number(minor || 0) / 100);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

async function loadOverview() {
  try {
    const query = new URLSearchParams({
      search: $("#serviceSearch").value,
      state: $("#stateFilter").value,
    });
    const [status, services] = await Promise.all([api("/api/status"), api(`/api/services?${query}`)]);
    const values = { total: status.summary.total, ...status.summary.states };
    $("#summary").innerHTML = Object.entries(values).map(([name, value]) =>
      `<div class="summary-item"><small>${escapeHtml(name)}</small><strong>${value}</strong></div>`).join("");
    $("#servicesBody").innerHTML = services.services.map((service) => `
      <tr>
        <td><strong>${escapeHtml(service.primary_domain)}</strong><small>${escapeHtml(service.service_id)}</small></td>
        <td><strong>${escapeHtml(service.customer_name || "Not set")}</strong><small>${escapeHtml(service.contact_email)}</small></td>
        <td>${escapeHtml(formatDate(service.hosting_paid_through))}</td>
        <td>${escapeHtml(formatDate(service.domain_paid_through))}</td>
        <td><span class="state state-${escapeHtml(service.hosting_state)}">${escapeHtml(service.hosting_state)}</span></td>
        <td><strong>${escapeHtml(service.location)}</strong><small>${escapeHtml(service.provider)}</small></td>
        <td><strong>${escapeHtml(formatMoney(service.hosting_price_minor, service.currency))}</strong><small>${service.renewal_months} months</small></td>
        <td><button class="secondary" data-payment-service="${escapeHtml(service.service_id)}"
          data-payment-domain="${escapeHtml(service.primary_domain)}"
          data-payment-months="${service.renewal_months}"
          data-payment-amount="${Number(service.hosting_price_minor || 0)}">Payment</button></td>
      </tr>`).join("");
    $("#emptyServices").hidden = services.services.length > 0;
    $("#policyForm").elements.reminder_days.value = status.reminderDays;
  } catch (error) {
    notice(error.message, true);
  }
}

async function loadPayments() {
  try {
    const [settingsResult, paymentsResult] = await Promise.all([
      api("/api/woocommerce/settings"),
      api("/api/payments"),
    ]);
    const settings = settingsResult.settings;
    const form = $("#wooSettingsForm");
    form.elements.site_url.value = settings.siteUrl;
    form.elements.public_billing_url.value = settings.publicBillingUrl;
    form.elements.product_id.value = settings.productId || "";
    form.elements.link_hours.value = settings.linkHours || 72;
    form.elements.consumer_key.value = "";
    form.elements.consumer_secret.value = "";
    form.elements.webhook_secret.value = "";
    $("#wooStatus").textContent = settings.ready
      ? "Configured. Saved credentials are encrypted and never returned."
      : "Not ready. Save URL, product, API credentials, and webhook secret.";
    $("#paymentsBody").innerHTML = paymentsResult.payments.map((payment) => `
      <tr>
        <td>${escapeHtml(formatDate(payment.created_at))}</td>
        <td><strong>${escapeHtml(payment.primary_domain)}</strong><small>${escapeHtml(payment.service_id)}</small></td>
        <td>#${payment.woo_order_id}</td>
        <td>${escapeHtml(formatMoney(payment.amount_minor, payment.currency))}</td>
        <td>${payment.months} months</td>
        <td><span class="state state-${payment.status === "paid" ? "active" : payment.status === "pending" ? "reminder" : "exempt"}">${escapeHtml(payment.status)}</span></td>
        <td>${escapeHtml(formatDate(payment.expires_at))}</td>
      </tr>`).join("");
    $("#emptyPayments").hidden = paymentsResult.payments.length > 0;
  } catch (error) {
    notice(error.message, true);
  }
}

function timingLabel(days) {
  const value = Number(days);
  if (value === 0) return "Due today";
  return value > 0 ? `${value} days remaining` : `${Math.abs(value)} days overdue`;
}

async function loadReminders() {
  try {
    const result = await api("/api/reminders");
    const form = $("#reminderSettingsForm");
    form.elements.enabled.checked = result.settings.enabled;
    form.elements.time.value = result.settings.time;
    $("#reminderScheduleStatus").textContent = result.settings.enabled
      ? `Enabled at ${result.settings.time}. Last scheduler run: ${result.settings.lastRun || "not yet"}.`
      : "Disabled. Manual preview and Send due now remain available.";
    $("#reminderPreviewBody").innerHTML = result.preview.map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.domain)}</strong><small>${escapeHtml(item.service_id)}</small></td>
        <td><span class="state state-${escapeHtml(item.state)}">${escapeHtml(item.state)}</span></td>
        <td>${escapeHtml(formatDate(item.paid_through))}</td>
        <td>${escapeHtml(timingLabel(item.days_remaining))}</td>
        <td>${escapeHtml(item.delivery_status)}</td>
      </tr>`).join("");
    $("#emptyReminderPreview").hidden = result.preview.length > 0;
    $("#reminderHistoryBody").innerHTML = result.history.map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.domain)}</strong><small>${escapeHtml(item.service_id)}</small></td>
        <td>${escapeHtml(item.state)}</td>
        <td>${escapeHtml(formatDate(item.paid_through))}</td>
        <td>${escapeHtml(item.status)}</td>
        <td>${item.attempts}</td>
        <td>${escapeHtml(formatDate(item.sent_at))}</td>
        <td>${escapeHtml(item.error)}</td>
      </tr>`).join("");
    $("#emptyReminderHistory").hidden = result.history.length > 0;
  } catch (error) {
    notice(error.message, true);
  }
}

async function loadBackups() {
  try {
    const result = await api("/api/backups");
    $("#backupsBody").innerHTML = result.backups.map((backup) => `
      <tr>
        <td><strong>${escapeHtml(formatDate(backup.createdAt))}</strong><small>${escapeHtml(backup.id)}</small></td>
        <td>${backup.services}</td>
        <td>${escapeHtml(formatBytes(backup.size))}</td>
        <td>${escapeHtml(backup.reason)}</td>
        <td><div class="row-actions">
          <button class="secondary" data-test-backup="${escapeHtml(backup.id)}">Test</button>
          <button class="danger" data-restore-backup="${escapeHtml(backup.id)}">Restore</button>
        </div></td>
      </tr>`).join("");
    $("#emptyBackups").hidden = result.backups.length > 0;
  } catch (error) {
    notice(error.message, true);
  }
}

async function loadAudit() {
  try {
    const result = await api("/api/audit?limit=250");
    $("#auditBody").innerHTML = result.audit.map((entry) => `
      <tr>
        <td>${escapeHtml(formatDate(entry.created_at))}</td>
        <td>${escapeHtml(entry.actor)}</td>
        <td>${escapeHtml(entry.action)}</td>
        <td>${escapeHtml(entry.target)}</td>
        <td>${escapeHtml(JSON.stringify(entry.summary))}</td>
      </tr>`).join("");
  } catch (error) {
    notice(error.message, true);
  }
}

async function initialize() {
  const status = await api("/api/auth/status");
  if (!status.authenticated) {
    $("#loginView").hidden = false;
    $("#appView").hidden = true;
    return;
  }
  state.csrf = status.csrf;
  state.email = status.email;
  $("#accountEmail").textContent = status.email;
  $("#accountForm").elements.email.value = status.email;
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  showView("overview");
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  try {
    await busy(button, async () => {
      const result = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      state.csrf = result.csrf;
      state.email = result.email;
      $("#loginError").hidden = true;
      await initialize();
    });
  } catch (error) {
    $("#loginError").textContent = error.message;
    $("#loginError").hidden = false;
  }
});

$("#logoutButton").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  state.csrf = "";
  location.reload();
});

$$("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$("#mobileNav").addEventListener("change", (event) => showView(event.target.value));
$("#refreshServices").addEventListener("click", loadOverview);
$("#stateFilter").addEventListener("change", loadOverview);
let searchTimer;
$("#serviceSearch").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadOverview, 250);
});

$("#servicesBody").addEventListener("click", (event) => {
  const serviceId = event.target.dataset.paymentService;
  if (!serviceId) return;
  const form = $("#paymentLinkForm");
  form.hidden = false;
  form.elements.service_id.value = serviceId;
  form.elements.months.value = event.target.dataset.paymentMonths;
  form.elements.amount.value = (Number(event.target.dataset.paymentAmount) / 100).toFixed(2);
  $("#paymentService").textContent = event.target.dataset.paymentDomain;
  $("#paymentLinkResult").hidden = true;
  showView("payments");
});

$("#wooSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  try {
    await busy(button, async () => {
      const values = Object.fromEntries(new FormData(form));
      const result = await api("/api/woocommerce/settings", {
        method: "PUT",
        body: JSON.stringify(values),
      });
      notice("WooCommerce integration saved with encrypted credentials.");
      $("#wooStatus").textContent = result.settings.ready ? "Configured and ready." : "Configuration is incomplete.";
      form.elements.consumer_key.value = "";
      form.elements.consumer_secret.value = "";
      form.elements.webhook_secret.value = "";
    });
  } catch (error) {
    notice(error.message, true);
  }
});

$("#testWoo").addEventListener("click", async (event) => {
  try {
    await busy(event.currentTarget, async () => {
      const result = await api("/api/woocommerce/test", { method: "POST" });
      notice(`WooCommerce connected. Renewal product: ${result.result.productName} (#${result.result.productId}).`);
    });
  } catch (error) {
    notice(error.message, true);
  }
});

$("#paymentLinkForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector(".primary");
  try {
    await busy(button, async () => {
      const amount = Number(form.elements.amount.value);
      const result = await api(`/api/services/${encodeURIComponent(form.elements.service_id.value)}/payment-link`, {
        method: "POST",
        body: JSON.stringify({
          months: Number(form.elements.months.value),
          amount_minor: Math.round(amount * 100),
        }),
      });
      $("#paymentLinkUrl").href = result.payment.paymentUrl;
      $("#paymentLinkUrl").textContent = result.payment.paymentUrl;
      $("#paymentLinkExpiry").textContent = `Expires ${formatDate(result.payment.expiresAt)} · WooCommerce order #${result.payment.orderId}`;
      $("#paymentLinkResult").hidden = false;
      notice("Payment link created. It is shown only in this result.");
      await loadPayments();
      $("#paymentLinkResult").hidden = false;
    });
  } catch (error) {
    notice(error.message, true);
  }
});

$("#cancelPaymentLink").addEventListener("click", () => {
  $("#paymentLinkForm").reset();
  $("#paymentLinkForm").hidden = true;
  $("#paymentLinkResult").hidden = true;
});

$("#reminderSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  try {
    await busy(button, async () => {
      await api("/api/reminders/settings", {
        method: "PUT",
        body: JSON.stringify({
          enabled: form.elements.enabled.checked,
          time: form.elements.time.value,
        }),
      });
      notice("Reminder schedule saved.");
      await loadReminders();
    });
  } catch (error) {
    notice(error.message, true);
  }
});

$("#runReminders").addEventListener("click", async (event) => {
  try {
    await busy(event.currentTarget, async () => {
      const result = await api("/api/reminders/run", { method: "POST" });
      const sent = result.result.results.filter((item) => item.ok).length;
      const failed = result.result.results.length - sent;
      notice(`Reminder run complete: ${sent} sent, ${failed} failed, ${result.result.due} due.`);
      await loadReminders();
    });
  } catch (error) {
    notice(error.message, true);
  }
});

$("#importForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  try {
    await busy(button, async () => {
      const file = $("#csvFile").files[0];
      if (!file) throw new Error("Select a CSV file");
      state.csv = await file.text();
      const preview = await api("/api/import/preview", {
        method: "POST",
        body: JSON.stringify({ csv: state.csv }),
      });
      state.fingerprint = preview.fingerprint;
      $("#importCount").textContent = `${preview.count} services validated`;
      $("#importFingerprint").textContent = preview.fingerprint;
      $("#importBody").innerHTML = preview.sample.map((service) => `
        <tr><td>${escapeHtml(service.service_id)}</td><td>${escapeHtml(service.primary_domain)}</td>
        <td>${escapeHtml(service.customer_name)}</td><td>${escapeHtml(formatDate(service.hosting_paid_through))}</td></tr>`).join("");
      $("#importPreview").hidden = false;
    });
  } catch (error) {
    notice(`${error.message}${error.details ? `: ${error.details.map((item) => `row ${item.row} ${item.message}`).join("; ")}` : ""}`, true);
  }
});

$("#applyImportForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  try {
    await busy(button, async () => {
      const result = await api("/api/import/apply", {
        method: "POST",
        body: JSON.stringify({
          csv: state.csv,
          fingerprint: state.fingerprint,
          confirm: form.elements.confirm.value,
        }),
      });
      notice(`Imported ${result.result.rows} services: ${result.result.inserted} new, ${result.result.updated} updated.`);
      form.reset();
      $("#importPreview").hidden = true;
      state.csv = "";
      state.fingerprint = "";
      showView("overview");
    });
  } catch (error) {
    notice(error.message, true);
  }
});

$("#createBackup").addEventListener("click", async (event) => {
  try {
    await busy(event.currentTarget, async () => {
      const result = await api("/api/backups", { method: "POST" });
      notice(`Backup ${result.backup.id} created and verified.`);
      await loadBackups();
    });
  } catch (error) {
    notice(error.message, true);
  }
});

$("#backupsBody").addEventListener("click", async (event) => {
  const testId = event.target.dataset.testBackup;
  const restoreId = event.target.dataset.restoreBackup;
  if (testId) {
    try {
      await busy(event.target, async () => {
        const result = await api(`/api/backups/${encodeURIComponent(testId)}/test`, { method: "POST" });
        notice(`Restore test passed: ${result.result.services} services, schema ${result.result.schemaVersion}.`);
      });
    } catch (error) {
      notice(error.message, true);
    }
  }
  if (restoreId) {
    state.restoreId = restoreId;
    $("#restoreTitle").textContent = `Restore ${restoreId}`;
    $("#restoreForm").hidden = false;
    $("#restoreForm").elements.confirm.focus();
  }
});

$("#cancelRestore").addEventListener("click", () => {
  state.restoreId = "";
  $("#restoreForm").reset();
  $("#restoreForm").hidden = true;
});

$("#restoreForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector(".danger");
  try {
    await busy(button, async () => {
      const result = await api(`/api/backups/${encodeURIComponent(state.restoreId)}/restore`, {
        method: "POST",
        body: JSON.stringify({ confirm: form.elements.confirm.value }),
      });
      notice(`Restored ${result.result.restored}. Safety backup: ${result.result.safetyBackup}.`);
      state.restoreId = "";
      form.reset();
      form.hidden = true;
      await loadBackups();
    });
  } catch (error) {
    notice(error.message, true);
  }
});

$("#refreshAudit").addEventListener("click", loadAudit);

$("#policyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  try {
    await busy(button, async () => {
      const result = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ reminder_days: Number(form.elements.reminder_days.value) }),
      });
      notice(`Reminder window updated to ${result.reminderDays} days.`);
      await loadOverview();
    });
  } catch (error) {
    notice(error.message, true);
  }
});

$("#accountForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  try {
    await busy(button, async () => {
      const result = await api("/api/auth/account", {
        method: "PUT",
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      state.csrf = result.csrf;
      state.email = result.email;
      $("#accountEmail").textContent = result.email;
      form.elements.current_password.value = "";
      form.elements.new_password.value = "";
      notice("Administrator account updated.");
    });
  } catch (error) {
    notice(error.message, true);
  }
});

initialize().catch((error) => notice(error.message, true));
