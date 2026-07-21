function buildSiteRemovalPlan(input) {
  const site = input.site;
  const targetDomains = [site.host, ...(site.aliases || [])];
  const targetSet = new Set(targetDomains);
  const outsideSites = input.allSites.filter((item) => !targetSet.has(item.host));
  const poolSharedBy = outsideSites.filter((item) => item.port === site.port).map((item) => item.host);
  const rootSharedBy = outsideSites.filter((item) => item.root === site.root).map((item) => item.host);
  const databaseSharedBy = input.database
    ? (input.databaseReferences || [])
      .filter((item) => !targetSet.has(item.domain)
        && (item.name === input.database.name || item.user === input.database.user))
      .map((item) => item.domain)
    : [];

  const matchingNpmHosts = (input.npmHosts || []).filter((host) =>
    (host.domain_names || []).some((domain) => targetSet.has(domain)));
  const unsafeNpmHosts = matchingNpmHosts.filter((host) =>
    (host.domain_names || []).some((domain) => !targetSet.has(domain)));
  const hostCertificateIds = matchingNpmHosts.map((host) => Number(host.certificate_id || 0)).filter(Boolean);
  const certificates = (input.certificates || []).filter((certificate) =>
    hostCertificateIds.includes(Number(certificate.id))
      || (certificate.domain_names || []).some((domain) => targetSet.has(domain)));
  const certificateIds = [...new Set(certificates.map((certificate) => Number(certificate.id)).filter(Boolean))];
  const sharedCertificateIds = certificateIds.filter((certificateId) =>
    (input.npmHosts || []).some((host) =>
      Number(host.certificate_id || 0) === certificateId && !matchingNpmHosts.some((candidate) => candidate.id === host.id)));
  const mixedCertificates = certificates.filter((certificate) =>
    (certificate.domain_names || []).some((domain) => !targetSet.has(domain)));

  const directory = String(site.root || "").replace(/^\/var\/www\//, "").replace(/\/$/, "");
  const databaseSafe = Boolean(input.database) && input.databaseInspectionComplete !== false && databaseSharedBy.length === 0;
  const npmHostSafe = matchingNpmHosts.length > 0 && unsafeNpmHosts.length === 0;
  const certificateSafe = certificates.length > 0 && sharedCertificateIds.length === 0 && mixedCertificates.length === 0;

  return {
    domain: site.host,
    targetDomains,
    directory,
    root: site.root,
    pool: { name: site.poolName || "", port: site.port || null },
    database: input.database || null,
    warnings: input.warnings || [],
    resources: {
      runtime: { available: true, safe: true, count: targetDomains.length, items: targetDomains },
      pool: {
        available: Boolean(site.poolName),
        safe: poolSharedBy.length === 0,
        count: site.poolName ? 1 : 0,
        items: site.poolName ? [site.poolName] : [],
        sharedBy: poolSharedBy,
      },
      files: {
        available: Boolean(directory),
        safe: Boolean(directory) && rootSharedBy.length === 0,
        count: directory ? 1 : 0,
        items: directory ? [directory] : [],
        sharedBy: rootSharedBy,
      },
      database: {
        available: Boolean(input.database),
        safe: databaseSafe,
        count: input.database ? 1 : 0,
        items: input.database ? [input.database.name, input.database.user] : [],
        sharedBy: databaseSharedBy,
      },
      npmHost: {
        available: matchingNpmHosts.length > 0,
        safe: npmHostSafe,
        count: matchingNpmHosts.length,
        ids: matchingNpmHosts.map((host) => host.id),
        items: matchingNpmHosts.flatMap((host) => host.domain_names || []),
      },
      npmCertificate: {
        available: certificates.length > 0,
        safe: certificateSafe,
        count: certificates.length,
        ids: certificates.map((certificate) => certificate.id),
        items: certificates.map((certificate) => certificate.nice_name || `Certificate #${certificate.id}`),
        sharedBy: sharedCertificateIds,
      },
      cloudflareDns: {
        available: (input.dnsRecords || []).length > 0,
        safe: true,
        count: (input.dnsRecords || []).length,
        ids: (input.dnsRecords || []).map((record) => record.id),
        items: (input.dnsRecords || []).map((record) => `${record.type} ${record.name}`),
      },
      panelState: { available: true, safe: true, count: targetDomains.length, items: targetDomains },
      backups: {
        available: (input.backups || []).length > 0,
        safe: true,
        count: (input.backups || []).length,
        items: (input.backups || []).map((backup) => backup.id),
      },
      finalBackup: {
        available: Boolean(directory && (site.state?.siteType === "static" || input.database)),
        safe: Boolean(directory && (site.state?.siteType === "static" || input.database)),
        count: 1,
        items: [site.host],
      },
    },
  };
}

module.exports = { buildSiteRemovalPlan };
