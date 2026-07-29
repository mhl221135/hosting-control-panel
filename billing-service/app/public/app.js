const state = {
  csrf: "",
  email: "",
  csv: "",
  fingerprint: "",
  restoreId: "",
  view: "overview",
  services: [],
  selectedServiceId: "",
  reminderDays: 30,
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
  if (view === "services") loadServiceManager();
  if (view === "payments") loadPayments();
  if (view === "reminders") loadReminders();
  if (view === "backups") loadBackups();
  if (view === "audit") loadAudit();
  if (view === "account") loadReferenceStatus();
}

function formatDate(value) {
  if (!value) return "Not set";
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(parsed.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
}

function formatDateTime(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? String(value || "Not set")
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
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
    state.reminderDays = status.reminderDays;
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
        <td><div class="row-actions"><button class="secondary" data-edit-service="${escapeHtml(service.service_id)}">Edit</button><button class="secondary" data-payment-service="${escapeHtml(service.service_id)}"
          data-payment-domain="${escapeHtml(service.primary_domain)}"
          data-payment-currency="${escapeHtml(service.currency)}"
          data-payment-months="${service.renewal_months}"
          data-payment-amount="${Number(service.hosting_price_minor || 0)}"
          data-payment-hosting-date="${escapeHtml(service.hosting_paid_through)}"
          data-payment-domain-months="${service.domain_renewal_months}"
          data-payment-domain-amount="${Number(service.domain_price_minor || 0)}"
          data-payment-domain-date="${escapeHtml(service.domain_paid_through)}">Payment</button></div></td>
      </tr>`).join("");
    $("#emptyServices").hidden = services.services.length > 0;
    $("#policyForm").elements.reminder_days.value = status.reminderDays;
  } catch (error) {
    notice(error.message, true);
  }
}

function previewState(paidThrough, graceDays, manualState, domainState = false) {
  if (manualState && (!domainState || manualState === "exempt")) return manualState;
  if (!paidThrough) return "exempt";
  const paid = Date.parse(`${paidThrough}T23:59:59Z`);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (today <= paid - state.reminderDays * 86_400_000) return "active";
  if (today <= paid) return "reminder";
  if (today <= paid + Number(graceDays || 0) * 86_400_000) return "grace";
  return "suspended";
}

function setPreview(element, value) {
  element.textContent = value;
  element.className = `state state-${value}`;
}

function updateServicePreview() {
  const form = $("#serviceForm");
  setPreview($("#hostingStatePreview"), previewState(
    form.elements.hosting_paid_through.value,
    form.elements.grace_days.value,
    form.elements.manual_state.value,
  ));
  setPreview($("#domainStatePreview"), previewState(
    form.elements.domain_paid_through.value,
    form.elements.grace_days.value,
    form.elements.manual_state.value,
    true,
  ));
}

function resetServiceForm() {
  const form = $("#serviceForm");
  form.reset();
  form.elements.service_id.value = "";
  form.elements.updated_at.value = "";
  form.elements.renewal_months.value = 12;
  form.elements.domain_renewal_months.value = 12;
  form.elements.hosting_price.value = "0";
  form.elements.domain_price.value = "0";
  form.elements.currency.value = "USD";
  form.elements.grace_days.value = 7;
  form.elements.timezone.value = "UTC";
  form.elements.manual_state.value = "";
  state.selectedServiceId = "";
  $("#serviceEditorMode").textContent = "New record";
  $("#serviceEditorTitle").textContent = "Add billing service";
  $("#serviceArchiveState").hidden = true;
  $("#archiveService").hidden = true;
  $("#manualActions").hidden = true;
  $("#manualActionReason").value = "";
  $("#manualStateValue").textContent = "Calculated from renewal date";
  $$(".service-item").forEach((item) => item.classList.remove("active"));
  updateServicePreview();
}

function editService(serviceId) {
  const service = state.services.find((item) => item.service_id === serviceId);
  if (!service) return;
  const form = $("#serviceForm");
  const values = {
    ...service,
    aliases: service.aliases.join("; "),
    hosting_price: (Number(service.hosting_price_minor) / 100).toFixed(2),
    domain_price: (Number(service.domain_price_minor) / 100).toFixed(2),
  };
  Object.entries(values).forEach(([name, value]) => {
    if (form.elements[name]) form.elements[name].value = value ?? "";
  });
  state.selectedServiceId = serviceId;
  $("#serviceEditorMode").textContent = "Editing record";
  $("#serviceEditorTitle").textContent = service.primary_domain;
  $("#serviceArchiveState").hidden = !service.archived;
  const archiveButton = $("#archiveService");
  archiveButton.hidden = false;
  archiveButton.textContent = service.archived ? "Restore record" : "Archive record";
  archiveButton.classList.toggle("danger", !service.archived);
  archiveButton.classList.toggle("secondary", service.archived);
  $("#manualActions").hidden = service.archived;
  $("#manualActionReason").value = "";
  $("#manualStateValue").textContent = service.manual_state
    ? `Forced to ${service.manual_state}`
    : "Calculated from renewal date";
  $$(".service-item").forEach((item) => item.classList.toggle("active", item.dataset.serviceId === serviceId));
  updateServicePreview();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadServiceManager(preferredServiceId = state.selectedServiceId) {
  try {
    const query = new URLSearchParams({
      search: $("#managerSearch").value,
      state: $("#managerState").value,
      archived: $("#archiveFilter").value,
    });
    const result = await api(`/api/services?${query}`);
    state.services = result.services;
    $("#serviceList").innerHTML = result.services.map((service) => `
      <button type="button" class="service-item${service.service_id === preferredServiceId ? " active" : ""}" data-service-id="${escapeHtml(service.service_id)}">
        <strong>${escapeHtml(service.primary_domain)}</strong>
        <span class="service-item-meta"><small>${escapeHtml(service.customer_name || service.location)}</small>
        <span class="state state-${service.archived ? "exempt" : escapeHtml(service.hosting_state)}">${service.archived ? "archived" : escapeHtml(service.hosting_state)}</span></span>
      </button>`).join("");
    $("#emptyServiceList").hidden = result.services.length > 0;
    if (preferredServiceId && result.services.some((service) => service.service_id === preferredServiceId)) {
      editService(preferredServiceId);
    } else {
      resetServiceForm();
    }
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
        <td>${escapeHtml(payment.selection)}</td>
        <td>${escapeHtml(formatMoney(payment.amount_minor, payment.currency))}</td>
        <td>${payment.hosting_months ? `Hosting ${payment.hosting_months}m` : ""}${payment.hosting_months && payment.domain_months ? " · " : ""}${payment.domain_months ? `Domain ${payment.domain_months}m` : ""}</td>
        <td><span class="state state-${payment.status === "paid" ? "active" : payment.status === "pending" ? "reminder" : "exempt"}">${escapeHtml(payment.status)}</span></td>
        <td>${escapeHtml(formatDate(payment.expires_at))}</td>
        <td>${payment.status === "pending" ? `<div class="row-actions">
          <button class="secondary" data-cancel-payment="${escapeHtml(payment.payment_id)}"
            data-payment-domain="${escapeHtml(payment.primary_domain)}"
            data-payment-order="${payment.woo_order_id}">Cancel</button>
          <button class="secondary" data-replace-payment="${escapeHtml(payment.payment_id)}"
            data-payment-service="${escapeHtml(payment.service_id)}"
            data-payment-domain="${escapeHtml(payment.primary_domain)}"
            data-payment-currency="${escapeHtml(payment.currency)}"
            data-payment-selection="${escapeHtml(payment.selection)}"
            data-payment-hosting-months="${payment.hosting_months}"
            data-payment-domain-months="${payment.domain_months}"
            data-payment-hosting-amount="${Number(payment.service_hosting_price_minor || 0)}"
            data-payment-domain-amount="${Number(payment.service_domain_price_minor || 0)}"
            data-payment-hosting-date="${escapeHtml(payment.hosting_paid_through)}"
            data-payment-domain-date="${escapeHtml(payment.domain_paid_through)}">Replace</button>
        </div>` : ""}</td>
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

async function loadReferenceStatus() {
  try {
    const result = await api("/api/public-reference/status");
    const previous = result.status.previous;
    $("#referenceKeyStatus").textContent = previous?.active
      ? `Active ${result.status.activeFingerprint}. Old URLs remain valid until ${formatDateTime(previous.expiresAt)}.`
      : `Active ${result.status.activeFingerprint}. No previous key is in its overlap window.`;
    $("#referenceRotationForm").querySelector(".danger").disabled = Boolean(previous?.active);
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
  const editId = event.target.dataset.editService;
  if (editId) {
    state.selectedServiceId = editId;
    showView("services");
    return;
  }
  const serviceId = event.target.dataset.paymentService;
  if (!serviceId) return;
  const form = $("#paymentLinkForm");
  form.hidden = false;
  $("#paymentFormTitle").textContent = "Create payment link";
  form.elements.service_id.value = serviceId;
  form.elements.currency.value = event.target.dataset.paymentCurrency;
  form.elements.replace_payment_id.value = "";
  form.elements.replacement_reason.value = "";
  form.elements.replacement_reason.required = false;
  $("#replacementReasonField").hidden = true;
  form.elements.selection.value = "hosting";
  form.elements.hosting_months.value = event.target.dataset.paymentMonths;
  form.elements.hosting_amount.value = (Number(event.target.dataset.paymentAmount) / 100).toFixed(2);
  form.elements.hosting_paid_through.value = event.target.dataset.paymentHostingDate || "Not set";
  form.elements.domain_months.value = event.target.dataset.paymentDomainMonths;
  form.elements.domain_amount.value = (Number(event.target.dataset.paymentDomainAmount) / 100).toFixed(2);
  form.elements.domain_paid_through.value = event.target.dataset.paymentDomainDate || "Not set";
  $("#paymentService").textContent = event.target.dataset.paymentDomain;
  $("#paymentLinkResult").hidden = true;
  updatePaymentSelection();
  showView("payments");
});

function updatePaymentSelection() {
  const form = $("#paymentLinkForm");
  const selection = form.elements.selection.value;
  const hosting = selection === "hosting" || selection === "both";
  const domain = selection === "domain" || selection === "both";
  $("#paymentHostingFields").hidden = !hosting;
  $("#paymentDomainFields").hidden = !domain;
  [...$("#paymentHostingFields").querySelectorAll("input:not([readonly])")].forEach((input) => { input.required = hosting; });
  [...$("#paymentDomainFields").querySelectorAll("input:not([readonly])")].forEach((input) => { input.required = domain; });
  const total = (hosting ? Number(form.elements.hosting_amount.value || 0) : 0)
    + (domain ? Number(form.elements.domain_amount.value || 0) : 0);
  $("#paymentTotal").textContent = formatMoney(Math.round(total * 100), form.elements.currency.value || "USD");
}

$("#paymentLinkForm").elements.selection.addEventListener("change", updatePaymentSelection);
["hosting_amount", "domain_amount"].forEach((name) => {
  $("#paymentLinkForm").elements[name].addEventListener("input", updatePaymentSelection);
});

$("#paymentsBody").addEventListener("click", (event) => {
  const cancel = event.target.closest("[data-cancel-payment]");
  if (cancel) {
    const form = $("#paymentCancelForm");
    form.hidden = false;
    form.elements.payment_id.value = cancel.dataset.cancelPayment;
    form.elements.reason.value = "";
    $("#paymentCancelTarget").textContent =
      `${cancel.dataset.paymentDomain} · WooCommerce order #${cancel.dataset.paymentOrder}`;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const replace = event.target.closest("[data-replace-payment]");
  if (!replace) return;
  const form = $("#paymentLinkForm");
  form.hidden = false;
  $("#paymentFormTitle").textContent = `Replace payment link for ${replace.dataset.paymentDomain}`;
  form.elements.service_id.value = replace.dataset.paymentService;
  form.elements.currency.value = replace.dataset.paymentCurrency;
  form.elements.replace_payment_id.value = replace.dataset.replacePayment;
  form.elements.replacement_reason.value = "";
  form.elements.replacement_reason.required = true;
  $("#replacementReasonField").hidden = false;
  form.elements.selection.value = replace.dataset.paymentSelection;
  form.elements.hosting_months.value = replace.dataset.paymentHostingMonths || 12;
  form.elements.hosting_amount.value =
    (Number(replace.dataset.paymentHostingAmount || 0) / 100).toFixed(2);
  form.elements.hosting_paid_through.value = replace.dataset.paymentHostingDate || "Not set";
  form.elements.domain_months.value = replace.dataset.paymentDomainMonths || 12;
  form.elements.domain_amount.value =
    (Number(replace.dataset.paymentDomainAmount || 0) / 100).toFixed(2);
  form.elements.domain_paid_through.value = replace.dataset.paymentDomainDate || "Not set";
  $("#paymentService").textContent = replace.dataset.paymentDomain;
  $("#paymentLinkResult").hidden = true;
  updatePaymentSelection();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
});

$("#newService").addEventListener("click", () => {
  resetServiceForm();
  $("#serviceForm").elements.primary_domain.focus();
});

$("#cancelServiceEdit").addEventListener("click", resetServiceForm);

$("#serviceList").addEventListener("click", (event) => {
  const item = event.target.closest("[data-service-id]");
  if (item) editService(item.dataset.serviceId);
});

let managerSearchTimer;
$("#managerSearch").addEventListener("input", () => {
  clearTimeout(managerSearchTimer);
  managerSearchTimer = setTimeout(() => loadServiceManager(""), 250);
});
$("#archiveFilter").addEventListener("change", () => loadServiceManager(""));
$("#managerState").addEventListener("change", () => loadServiceManager(""));

["hosting_paid_through", "domain_paid_through", "grace_days", "manual_state"].forEach((name) => {
  $("#serviceForm").elements[name].addEventListener("input", updateServicePreview);
});

$("#serviceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector(".primary");
  try {
    await busy(button, async () => {
      const body = Object.fromEntries(new FormData(form));
      const serviceId = body.service_id;
      const result = await api(serviceId ? `/api/services/${encodeURIComponent(serviceId)}` : "/api/services", {
        method: serviceId ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      notice(serviceId ? "Billing service updated." : "Billing service created.");
      await loadServiceManager(result.service.service_id);
      await loadOverview();
    });
  } catch (error) {
    notice(error.message, true);
  }
});

$("#archiveService").addEventListener("click", async (event) => {
  const service = state.services.find((item) => item.service_id === state.selectedServiceId);
  if (!service) return;
  const archived = !service.archived;
  const action = archived ? "archive" : "restore";
  if (!window.confirm(`${action[0].toUpperCase()}${action.slice(1)} ${service.primary_domain}? Billing and audit history will be preserved.`)) return;
  try {
    await busy(event.currentTarget, async () => {
      await api(`/api/services/${encodeURIComponent(service.service_id)}/archive`, {
        method: "POST",
        body: JSON.stringify({ archived, updated_at: service.updated_at }),
      });
      notice(`Billing service ${archived ? "archived" : "restored"}.`);
      await loadServiceManager("");
      await loadOverview();
    });
  } catch (error) {
    notice(error.message, true);
  }
});

$("#manualActions").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-manual-action]");
  if (!button) return;
  const service = state.services.find((item) => item.service_id === state.selectedServiceId);
  if (!service || service.archived) return;
  const action = button.dataset.manualAction;
  const reason = $("#manualActionReason").value.trim();
  if (reason.length < 3) {
    notice("Enter a reason of at least 3 characters.", true);
    $("#manualActionReason").focus();
    return;
  }
  const labels = { exempt: "exempt", resume: "resume calculated state for", suspend: "mark as suspended" };
  if (!window.confirm(`Apply ${labels[action]} ${service.primary_domain}?\n\nReason: ${reason}`)) return;
  try {
    await busy(button, async () => {
      const result = await api(
        `/api/services/${encodeURIComponent(service.service_id)}/actions/${encodeURIComponent(action)}`,
        {
          method: "POST",
          body: JSON.stringify({ reason, updated_at: service.updated_at }),
        },
      );
      notice(`${service.primary_domain} billing state updated.`);
      await loadServiceManager(result.service.service_id);
      await loadOverview();
    });
  } catch (error) {
    notice(error.message, true);
  }
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
      const selection = form.elements.selection.value;
      const result = await api(`/api/services/${encodeURIComponent(form.elements.service_id.value)}/payment-link`, {
        method: "POST",
        body: JSON.stringify({
          selection,
          hosting_months: Number(form.elements.hosting_months.value),
          hosting_amount_minor: Math.round(Number(form.elements.hosting_amount.value) * 100),
          domain_months: Number(form.elements.domain_months.value),
          domain_amount_minor: Math.round(Number(form.elements.domain_amount.value) * 100),
          replace_payment_id: form.elements.replace_payment_id.value,
          replacement_reason: form.elements.replacement_reason.value,
        }),
      });
      $("#paymentLinkUrl").href = result.payment.paymentUrl;
      $("#paymentLinkUrl").textContent = result.payment.paymentUrl;
      $("#renewalPageUrl").href = result.payment.renewalUrl;
      $("#renewalPageUrl").textContent = result.payment.renewalUrl;
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
  $("#replacementReasonField").hidden = true;
  $("#paymentFormTitle").textContent = "Create payment link";
});

$("#paymentCancelForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector(".danger");
  try {
    await busy(button, async () => {
      await api(`/api/payments/${encodeURIComponent(form.elements.payment_id.value)}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: form.elements.reason.value }),
      });
      notice("Pending WooCommerce order cancelled.");
      form.reset();
      form.hidden = true;
      await loadPayments();
    });
  } catch (error) {
    notice(error.message, true);
  }
});

$("#closePaymentCancel").addEventListener("click", () => {
  $("#paymentCancelForm").reset();
  $("#paymentCancelForm").hidden = true;
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

$("#referenceRotationForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector(".danger");
  try {
    await busy(button, async () => {
      const result = await api("/api/public-reference/rotate", {
        method: "POST",
        body: JSON.stringify({
          overlap_hours: Number(form.elements.overlap_hours.value),
          reason: form.elements.reason.value,
          confirm: form.elements.confirm.value,
        }),
      });
      form.elements.reason.value = "";
      form.elements.confirm.value = "";
      notice(`Renewal key rotated. Old URLs remain valid until ${formatDateTime(result.status.previous.expiresAt)}.`);
    });
    await loadReferenceStatus();
  } catch (error) {
    notice(error.message, true);
  }
});

initialize().catch((error) => notice(error.message, true));
