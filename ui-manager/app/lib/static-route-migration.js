const { parsePools, parseSitesMap, renderPools, renderSitesMap } = require("./runtime-config");

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

function migrateStaticRoutes({ mapContent, poolsContent, nginxContent, siteState }) {
  const map = parseSitesMap(mapContent);
  const pools = parsePools(poolsContent);
  const states = siteState?.sites && typeof siteState.sites === "object" ? siteState.sites : {};
  const staticDomains = Object.entries(states)
    .filter(([, state]) => state?.siteType === "static")
    .map(([domain]) => domain);
  const staticRoots = new Set();
  const skipped = [];

  for (const domain of staticDomains) {
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
    converted: converted.sort(),
    removedPools: removedPools.sort(),
    skipped: skipped.sort(),
  };
}

module.exports = { STATIC_GATE_MARKER, ensureStaticPhpGate, migrateStaticRoutes };
