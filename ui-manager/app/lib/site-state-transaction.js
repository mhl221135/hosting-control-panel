const { parsePools, parseSitesMap, renderPools, renderSitesMap, setPoolOpcache } = require("./runtime-config");
const { validateRuntimeModel } = require("./runtime-transaction");
const { atomicWriteFile, atomicWriteJson } = require("./safe-write");
const { renderCacheMapContent } = require("./site-state");

const REDACT_PATTERNS = [
  /\bauthorization\s*:\s*[a-z0-9._-]+\s+[a-z0-9._~/+\-]{6,}/gi,
  /\bbearer\s+[a-z0-9._~/+=-]{6,}/gi,
  /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|session[_-]?id|cookie)\b\s*[:=]\s*["']?[^\s,;}"']+/gi,
  /(?:https?:\/\/)[^\s/@]*(?=@)/gi,
];

function redact(value) {
  let output = String(value ?? "");
  for (const pattern of REDACT_PATTERNS) output = output.replace(pattern, "[redacted]");
  return output;
}

// Atomic, serialized coordinator for site-state mutations that may also change
// the PHP-FPM pool (opcache) and the generated nginx cache map. It runs under a
// single external lock (the shared runtime transaction lock) and never nests
// that lock, so it cannot deadlock. Every affected file is snapshotted before
// mutation and restored on failure, then the restored configuration is
// validated, reloaded, and its ports verified before "rolled back" is reported.
async function applySiteStateTransaction({ site, opcache, buildState, applyExternal, rollbackExternal, deps }) {
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
    let mutationStarted = false;
    let phpActivationAttempted = false;
    let nginxActivationAttempted = false;
    let externalAttempted = false;
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
      mutationStarted = true;
      atomicWriteJson(siteStatePath, newState, 0o600);
      atomicWriteFile(cacheMapPath, cacheRendered, 0o600);
      if (poolsRendered !== snap.pools) atomicWriteFile(poolsPath, poolsRendered, 0o600);
      if (sitesMapRendered !== snap.sitesMap) atomicWriteFile(sitesMapPath, sitesMapRendered, 0o600);

      const poolsChanged = poolsRendered !== snap.pools || sitesMapRendered !== snap.sitesMap;
      const cacheChanged = cacheRendered !== snap.cacheContent;
      if (poolsChanged) {
        await validateConfig();
        phpActivationAttempted = true;
        await reloadPhp();
        nginxActivationAttempted = true;
        await reloadNginx();
        await verifyPorts(collectPorts(poolsRendered));
      } else if (cacheChanged) {
        await validateConfig();
        nginxActivationAttempted = true;
        await reloadNginx();
      }
      if (applyExternal) {
        externalAttempted = true;
        await applyExternal();
      }
      return { rollback: "not-required", applied: true, state: newState.sites[site.host] };
    } catch (error) {
      error.message = redact(String(error?.message || error)).slice(0, 500);
      if (!mutationStarted && !externalAttempted) {
        error.rollback = "not-required";
        if (!error.statusCode) error.statusCode = 500;
        throw error;
      }
      let outcome = "succeeded";
      try {
        restore(snap);
        await validateConfig();
        if (externalAttempted && rollbackExternal) await rollbackExternal();
        if (phpActivationAttempted) await reloadPhp();
        if (nginxActivationAttempted) await reloadNginx();
        if (phpActivationAttempted) await verifyPorts(collectPorts(snap.pools));
      } catch (rollbackError) {
        outcome = "failed";
        error.rollbackError = redact(String(rollbackError?.message || rollbackError)).slice(0, 300);
      }
      error.rollback = outcome;
      if (!error.statusCode) error.statusCode = 502;
      throw error;
    }
  });
}

module.exports = { applySiteStateTransaction };
