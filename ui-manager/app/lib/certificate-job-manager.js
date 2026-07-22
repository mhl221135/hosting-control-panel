function certificateId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    const error = new Error("Certificate ID is invalid");
    error.statusCode = 400;
    throw error;
  }
  return id;
}

function domainsForHost(host) {
  return (Array.isArray(host?.domain_names) ? host.domain_names : []).map((domain) => String(domain).toLowerCase());
}

class CertificateJobManager {
  constructor(options) {
    this.jobManager = options.jobManager;
    this.npm = options.npm;
    this.jobManager.register("npm.certificate.issue", (context, payload) => this.issue(context, payload));
    this.jobManager.register("npm.certificate.renew", (context, payload) => this.renew(context, payload));
  }

  enqueueIssue(domains, operator) {
    const selected = [...new Set(domains.map((domain) => String(domain).toLowerCase()))];
    if (!selected.length) throw Object.assign(new Error("Select at least one domain"), { statusCode: 400 });
    return this.jobManager.create({
      type: "npm.certificate.issue",
      label: `Issue SSL certificate for ${selected[0]}`,
      operator,
      targets: selected,
      conflicts: ["integration:npm", ...selected.map((domain) => `site:${domain}`)],
      idempotencyKey: `npm.certificate.issue:${selected.sort().join(",")}`,
      payload: { domains: selected },
      total: 1,
      cancellable: false,
      retryable: false,
    });
  }

  enqueueRenew(domain, value, operator) {
    const selectedDomain = String(domain).toLowerCase();
    const id = certificateId(value);
    return this.jobManager.create({
      type: "npm.certificate.renew",
      label: `Renew SSL certificate for ${selectedDomain}`,
      operator,
      targets: [selectedDomain],
      conflicts: ["integration:npm", `site:${selectedDomain}`],
      idempotencyKey: `npm.certificate.renew:${selectedDomain}:${id}`,
      payload: { domain: selectedDomain, certificateId: id },
      total: 1,
      cancellable: false,
      retryable: false,
    });
  }

  async issue(context, payload) {
    context.update({ currentStep: `Requesting certificate for ${payload.domains[0]}` });
    const host = await this.npm.ensureHost(payload.domains, true);
    const id = certificateId(host?.certificate_id);
    return {
      ok: true,
      total: 1,
      completed: 1,
      message: `SSL certificate issued for ${payload.domains[0]}`,
      results: [{ domain: payload.domains[0], ok: true, certificateId: id }],
    };
  }

  async renew(context, payload) {
    context.update({ currentStep: `Validating certificate ownership for ${payload.domain}` });
    const id = certificateId(payload.certificateId);
    const hosts = await this.npm.listHosts();
    const ownsCertificate = hosts.some((host) =>
      Number(host.certificate_id) === id && domainsForHost(host).includes(payload.domain));
    if (!ownsCertificate) throw new Error(`Certificate ${id} is no longer attached to ${payload.domain}`);
    context.update({ currentStep: `Renewing certificate for ${payload.domain}` });
    await this.npm.renewCertificate(id);
    return {
      ok: true,
      total: 1,
      completed: 1,
      message: `SSL certificate renewed for ${payload.domain}`,
      results: [{ domain: payload.domain, ok: true, certificateId: id }],
    };
  }
}

module.exports = { CertificateJobManager, certificateId, domainsForHost };
