const {
  parsePools,
  parseSitesMap,
  renderPools,
  renderSitesMap,
  sanitizeSectionName,
} = require("./runtime-config");

const STATIC_GATE_MARKER = "# Managed static-route isolation.";

function ensureStaticPhpGate(content) {
  if (content.includes(STATIC_GATE_MARKER)) return content;
  const location = "    location ~ \\.php$ {\n";
  if (!content.includes(location)) throw new Error("Could not find the managed nginx PHP location");
  return content.replace(
    location,
    `${location}        ${STATIC_GATE_MARKER}\n        if ($site_php_enabled = 0) { return 404; }\n\n`,
  );
}

function migrateStaticRoutes({
  mapContent,
  poolsContent,
  nginxContent,
  siteState,
  legacyPhpDomains = [],
}) {
  const map = parseSitesMap(mapContent);
  const pools = parsePools(poolsContent);
  const normalizedState = JSON.parse(JSON.stringify(siteState || { sites: {} }));
  if (!normalizedState.sites || typeof normalizedState.sites !== "object") normalizedState.sites = {};
  const states = normalizedState.sites;
  const legacyPhp = new Set(legacyPhpDomains);
  const staticDomains = Object.entries(states)
    .filter(([, state]) => state?.siteType === "static")
    .map(([domain]) => domain);
  const staticRoots = new Set();
  const skipped = [];
  const reclassified = [];
  const recoveredPools = [];

  let nextPort = Math.max(
    9000,
    ...Object.values(pools.sections).map((pool) => Number(pool.listen)).filter(Number.isInteger),
  ) + 1;
  for (const domain of staticDomains.filter((item) => legacyPhp.has(item))) {
    const route = map.hosts[domain];
    if (!route?.root) {
      skipped.push(domain);
      continue;
    }
    const routes = Object.values(map.hosts).filter((candidate) => candidate.root === route.root);
    let port = routes.find((candidate) => candidate.phpEnabled !== false && candidate.port)?.port || null;
    if (!port) {
      port = nextPort++;
      const poolName = sanitizeSectionName(domain);
      if (pools.sections[poolName]) throw new Error(`Cannot recover PHP route ${domain}: pool ${poolName} already exists`);
      pools.sections[poolName] = {
        user: "www-data", group: "www-data", listen: String(port), pm: "dynamic",
        "pm.max_children": "6", "pm.start_servers": "2",
        "pm.min_spare_servers": "1", "pm.max_spare_servers": "3",
        "pm.process_idle_timeout": "30s", "pm.max_requests": "500",
        "php_admin_value[open_basedir]": `${route.root}/:/global/:/tmp/`,
        clear_env: "no", catch_workers_output: "yes", request_terminate_timeout: "120s",
      };
      pools.sectionOrder.push(poolName);
      recoveredPools.push(poolName);
    }
    for (const candidate of routes) {
      candidate.port = port;
      candidate.upstream = `hosting-php-fpm:${port}`;
      candidate.phpEnabled = true;
    }
    states[domain] = {
      ...states[domain],
      siteType: "generic-php",
      redis: false,
      imageOptimizationEnabled: false,
      updatedAt: new Date().toISOString(),
    };
    reclassified.push(domain);
  }

  for (const domain of staticDomains.filter((item) => !legacyPhp.has(item))) {
    const route = map.hosts[domain];
    if (!route?.root) {
      skipped.push(domain);
      continue;
    }
    const conflict = Object.entries(states).find(([otherDomain, state]) =>
      otherDomain !== domain
      && state?.siteType !== "static"
      && map.hosts[otherDomain]?.root === route.root);
    if (conflict) throw new Error(`Static route ${domain} shares its document root with ${conflict[0]}`);
    staticRoots.add(route.root);
  }

  const converted = [];
  const candidatePorts = new Set();
  for (const route of Object.values(map.hosts)) {
    if (!staticRoots.has(route.root)) continue;
    if (route.port) candidatePorts.add(route.port);
    route.port = null;
    route.upstream = "";
    route.phpEnabled = false;
    converted.push(route.host);
  }

  const activePorts = new Set(Object.values(map.hosts)
    .filter((route) => route.phpEnabled !== false && route.port)
    .map((route) => route.port));
  const removedPools = [];
  for (const name of [...pools.sectionOrder]) {
    const port = Number(pools.sections[name]?.listen);
    if (!candidatePorts.has(port) || activePorts.has(port)) continue;
    delete pools.sections[name];
    pools.sectionOrder = pools.sectionOrder.filter((item) => item !== name);
    removedPools.push(name);
  }

  return {
    mapContent: renderSitesMap(map),
    poolsContent: renderPools(pools),
    nginxContent: ensureStaticPhpGate(nginxContent),
    siteState: normalizedState,
    converted: converted.sort(),
    removedPools: removedPools.sort(),
    recoveredPools: recoveredPools.sort(),
    reclassified: reclassified.sort(),
    skipped: skipped.sort(),
  };
}

module.exports = { STATIC_GATE_MARKER, ensureStaticPhpGate, migrateStaticRoutes };
