const FIELDS = {
  finalBackup: "final_backup",
  cloudflareDns: "cloudflare_dns",
  npmHost: "npm_host",
  npmCertificate: "npm_certificate",
  runtime: "runtime",
  pool: "pool",
  panelState: "panel_state",
  database: "database",
  files: "files",
  backups: "backups",
};

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function validateSelection(selected) {
  if (!Object.keys(FIELDS).some((name) => Boolean(selected[name]))) {
    throw badRequest("Select at least one resource to delete");
  }
  if (selected.finalBackup && selected.backups) {
    throw badRequest("A final backup cannot be created and deleted in the same operation");
  }
  if (selected.pool && !selected.runtime) {
    throw badRequest("Remove runtime host records before removing their PHP pool");
  }
  return selected;
}

function parseSelection(domain, body) {
  if (String(body.confirm_domain || "").trim().toLowerCase() !== domain) {
    throw badRequest(`Type ${domain} exactly to confirm deletion`);
  }
  return validateSelection(Object.fromEntries(
    Object.entries(FIELDS).map(([name, field]) => [name, Boolean(body[field])]),
  ));
}

function jobInput(domain, selected, operator) {
  validateSelection(selected);
  return {
    type: "site.remove",
    label: `Delete ${domain}`,
    operator,
    trigger: "manual",
    targets: [domain],
    conflicts: ["server-heavy", "runtime-config", `site:${domain}`],
    idempotencyKey: `site.remove:${domain}`,
    payload: { domain, selected },
    total: Object.values(selected).filter(Boolean).length,
    cancellable: true,
    retryable: false,
  };
}

module.exports = { FIELDS, jobInput, parseSelection, validateSelection };
