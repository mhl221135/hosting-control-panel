const { parsePools, parseSitesMap, renderPools, renderSitesMap, setPoolOpcache } = require("./runtime-config");
const { validateRuntimeModel } = require("./runtime-transaction");
const { atomicWriteFile, atomicWriteJson } = require("./safe-write");

function renderCacheMapContent(data) {
  const sites = Object.entries((data && data.sites) || {}).sort(([left], [right]) => left.localeCompare(right));
  const enabled = ["map $host $site_cache_enabled {", "  default 0;"];
  const versions = ["map $host $site_cache_version {", "  default 1;"];
  for (const [domain, state] of sites) {
    enabled.push(`  ${domain} ${state.fastcgiCache ? 1 : 0};`);
    versions.push(`  ${domain} ${Number(state.cacheVersion || 1)};`);
  }
  enabled.push("}");
  versions.push("}");
  return `${enabled.join("\n")}\n\n${versions.join("\n")}\n`;
}

// Atomic, serialized coordinator for site-state mutations that may also change
// the PHP-FPM pool (opcache) and the generated nginx cache map. It runs under a
// single external lock (the shared runtime transaction lock) and never nests
// that lock, so it cannot deadlock. Every affected file is snapshotted before
// mutation and restored on failure, then the restored configuration is
// validated, reloaded, and its ports verified before "rolled back" is reported.
async function applySiteStateTransaction({ site, opcache, buildState, deps }) {
  const {
    sitesMapPath, poolsPath, siteStatePath, cacheMapPath,
    readFile, exists, removeFile, backupFile,
    validateConfig, reloadPhp, reloadNginx, verifyPorts, collectPorts,
    lock,
  } = deps;

  const stateSnapshot = () => ({
    sitesMap: readFile(sitesMapPath),
    pools: readFile(poolsPath),
    stateExists: exists(siteStatePath),
    stateContent: exists(siteStatePath) ? readFile(siteStatePath) : "",
    cacheExists: exists(cacheMapPath),
    cacheContent: exists(cacheMapPath) ? readFile(cacheMapPath) : "",
  });

  const restore = (snap) => {
    atomicWriteFile(sitesMapPath, snap.sitesMap, 0o600);
    atomicWriteFile(poolsPath, snap.pools, 0o600);
    if (snap.stateExists) atomicWriteFile(siteStatePath, snap.stateContent, 0o600);
    else if (exists(siteStatePath)) removeFile(siteStatePath);
    if (snap.cacheExists) atomicWriteFile(cacheMapPath, snap.cacheContent, 0o600);
    else if (exists(cacheMapPath)) removeFile(cacheMapPath);
  };

  return lock.runExclusive(async () => {
    const snap = stateSnapshot();
    let rollback = "not-required";
    try {
      const mapParsed = parseSitesMap(snap.sitesMap);
      const poolsParsed = parsePools(snap.pools);
      let sitesMapRendered = snap.sitesMap;
      let poolsRendered = snap.pools;
      if (opcache !== undefined) {
        const pool = poolsParsed.byPort[site.port];
        if (!pool) throw Object.assign(new Error("The site's PHP pool was not found"), { statusCode: 400 });
        setPoolOpcache(pool.settings, opcache);
        validateRuntimeModel(mapParsed, poolsParsed);
        sitesMapRendered = renderSitesMap(mapParsed);
        poolsRendered = renderPools(poolsParsed);
      }
      const newState = buildState(snap); // proposed full site-state model
      const cacheRendered = renderCacheMapContent(newState);

      if (backupFile) {
        backupFile(sitesMapPath, snap.sitesMap);
        backupFile(poolsPath, snap.pools);
        backupFile(siteStatePath, snap.stateContent);
        backupFile(cacheMapPath, snap.cacheContent);
      }
      atomicWriteJson(siteStatePath, newState, 0o600);
      atomicWriteFile(cacheMapPath, cacheRendered, 0o600);
      if (poolsRendered !== snap.pools) atomicWriteFile(poolsPath, poolsRendered, 0o600);
      if (sitesMapRendered !== snap.sitesMap) atomicWriteFile(sitesMapPath, sitesMapRendered, 0o600);

      const poolsChanged = poolsRendered !== snap.pools || sitesMapRendered !== snap.sitesMap;
      const cacheChanged = cacheRendered !== snap.cacheContent;
      if (poolsChanged) {
        await validateConfig();
        await reloadPhp();
        await reloadNginx();
        await verifyPorts(collectPorts(poolsRendered));
      } else if (cacheChanged) {
        await validateConfig();
        await reloadNginx();
      }
      return { rollback, applied: true, state: newState.sites[site.domain] };
    } catch (error) {
      let outcome = "succeeded";
      try {
        restore(snap);
        await validateConfig();
        await reloadPhp();
        await reloadNginx();
        await verifyPorts(collectPorts(snap.pools));
      } catch (rollbackError) {
        outcome = "failed";
        error.rollbackError = String(rollbackError?.message || rollbackError).slice(0, 300);
      }
      rollback = outcome;
      error.rollback = outcome;
      if (!error.statusCode) error.statusCode = 502;
      throw error;
    }
  });
}

module.exports = { applySiteStateTransaction, renderCacheMapContent };
