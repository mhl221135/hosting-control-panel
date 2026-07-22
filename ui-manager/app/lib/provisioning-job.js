const SAFE_FIELDS = new Set([
  "domain", "directory", "source_mode", "site_type", "admin_email", "admin_user", "title",
  "pool_tier", "opcache", "redis", "fastcgi_cache", "scheduled_backup",
  "scheduled_image_optimization", "enable_comments", "keep_default_plugins", "keep_default_themes",
  "plugin_packages", "theme_packages", "create_update_dns", "dns_ip", "apply_dns_preset",
  "dns_preset_id", "add_www", "create_npm_host", "issue_ssl", "notes", "import_upload_id",
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

module.exports = { SAFE_FIELDS, jobInput, safeProvisionPayload };
