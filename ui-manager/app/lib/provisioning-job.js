const SAFE_FIELDS = new Set([
  "domain", "directory", "source_mode", "site_type", "admin_email", "admin_user", "title",
  "pool_tier", "opcache", "redis", "fastcgi_cache", "scheduled_backup",
  "scheduled_image_optimization", "enable_comments", "keep_default_plugins", "keep_default_themes",
  "plugin_packages", "theme_packages", "create_update_dns", "dns_ip", "apply_dns_preset",
  "dns_preset_id", "add_www", "create_npm_host", "issue_ssl", "notes", "import_upload_id",
  "apply_security_preset", "security_preset",
]);

function safeProvisionPayload(body = {}) {
  const payload = {};
  for (const [key, value] of Object.entries(body)) {
    if (SAFE_FIELDS.has(key)) payload[key] = value;
  }
  return payload;
}

function jobInput({ body, domain, operator, requestRef = "" }) {
  return {
    type: "site.provision",
    label: `${body.source_mode === "import" ? "Import" : "Provision"} ${domain}`,
    operator,
    trigger: "manual",
    targets: [domain],
    conflicts: ["server-heavy", "runtime-config", `site:${domain}`],
    cancellable: true,
    retryable: false,
    total: 8,
    payload: {
      owner: operator,
      requestRef,
      request: safeProvisionPayload(body),
    },
  };
}

function jobResult(result) {
  const results = (result.steps || []).map((step) => ({ ...step, ok: step.status === "complete" }));
  const warnings = results.filter((step) => !step.ok).length;
  return {
    ok: warnings === 0,
    completed: 8,
    total: 8,
    message: `${result.domain} ${result.imported ? "imported" : "provisioned"}${warnings ? ` with ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`,
    results,
  };
}

module.exports = { SAFE_FIELDS, jobInput, jobResult, safeProvisionPayload };
