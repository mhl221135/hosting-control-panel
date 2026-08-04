#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { migrateStaticRoutes, activateStaticMigration } = require("../lib/static-route-migration");
const { parseSitesMap } = require("../lib/runtime-config");
const { DirectoryLock, atomicWriteFile, verifyPortsWithRetry } = require("../lib/runtime-transaction");

const execFileAsync = promisify(execFile);
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const SITES_MAP_PATH = process.env.SITES_MAP_PATH || "/srv/configs/nginx/conf.d/sites.map";
const POOLS_PATH = process.env.POOLS_PATH || "/srv/configs/php-fpm/pools.conf";
const NGINX_DEFAULT_PATH = process.env.NGINX_DEFAULT_PATH || "/srv/configs/nginx/conf.d/default.conf";
const WEBSITES_ROOT = process.env.WEBSITES_ROOT || "/srv/websites";
const STATE_PATH = `${DATA_DIR}/site-state.json`;

function containsPhpFiles(directory) {
  const stack = [directory];
  let inspected = 0;
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      inspected += 1;
      if (inspected > 250_000) throw new Error(`PHP detection exceeded the file limit in ${directory}`);
      const target = `${current}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && /\.(?:php\d*|phtml|phar)$/i.test(entry.name)) return true;
    }
  }
  return false;
}

function writePlan(result) {
  process.stdout.write(
    `Static isolation plan: ${result.converted.length} route(s), ${result.removedPools.length} unused pool(s)`
    + `, ${result.reclassified.length} PHP site(s) reclassified`
    + `${result.recoveredPools.length ? `, ${result.recoveredPools.length} pool(s) recovered` : ""}`
    + `${result.skipped.length ? `, ${result.skipped.length} missing route(s)` : ""}.\n`
    + `Routes: ${result.converted.join(", ") || "none"}\n`
    + `Pools to remove: ${result.removedPools.join(", ") || "none"}\n`
    + `Generic PHP: ${result.reclassified.join(", ") || "none"}\n`,
  );
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  if (args.has("--dry-run") && apply) throw new Error("Choose either --dry-run or --apply");

  const before = {
    map: fs.readFileSync(SITES_MAP_PATH, "utf8"),
    pools: fs.readFileSync(POOLS_PATH, "utf8"),
    nginx: fs.readFileSync(NGINX_DEFAULT_PATH, "utf8"),
  };
  const statePath = STATE_PATH;
  const stateExisted = fs.existsSync(statePath);
  const rawState = stateExisted ? fs.readFileSync(statePath, "utf8") : "";
  let siteState;
  try {
    siteState = rawState ? JSON.parse(rawState) : { sites: {} };
  } catch {
    throw new Error("site-state.json is invalid; refusing to replace it during static migration");
  }
  const beforeState = rawState;
  const currentMap = parseSitesMap(before.map);
  const legacyPhpDomains = Object.entries(siteState.sites || {})
    .filter(([, state]) => state?.siteType === "static")
    .filter(([domain]) => {
      const relative = String(currentMap.hosts[domain]?.root || "").replace(/^\/var\/www\//, "");
      const directory = path.resolve(WEBSITES_ROOT, relative);
      const root = path.resolve(WEBSITES_ROOT);
      if (!relative || !directory.startsWith(`${root}${path.sep}`)) return false;
      return fs.existsSync(directory) && containsPhpFiles(directory);
    })
    .map(([domain]) => domain);
  const result = migrateStaticRoutes({
    mapContent: before.map,
    poolsContent: before.pools,
    nginxContent: before.nginx,
    siteState,
    legacyPhpDomains,
  });
  const afterState = JSON.stringify(result.siteState, null, 2);
  const changed = result.mapContent !== before.map
    || result.poolsContent !== before.pools
    || result.nginxContent !== before.nginx
    || afterState !== beforeState;

  if (!changed) {
    process.stdout.write("Static route isolation is already current.\n");
    return;
  }
  writePlan(result);

  if (!apply) {
    process.stdout.write("Preview only: no files were changed. Re-run with --apply to commit this plan.\n");
    return;
  }

  const phpHost = process.env.PHP_CONTAINER || "hosting-php-fpm";
  const reloadNginx = async () => {
    await execFileAsync("docker", ["exec", "hosting-nginx", "nginx", "-s", "reload"], { timeout: 30_000 });
  };
  const reloadPhp = async () => {
    await execFileAsync("docker", ["exec", phpHost, "sh", "-c", "kill -USR2 1"], { timeout: 30_000 });
  };
  await activateStaticMigration({
    before: { ...before, state: beforeState, stateMode: 0o600, stateExisted },
    after: {
      mapContent: result.mapContent,
      poolsContent: result.poolsContent,
      nginxContent: result.nginxContent,
      state: `${afterState}\n`,
      stateMode: 0o600,
    },
    deps: {
      sitesMapPath: SITES_MAP_PATH,
      poolsPath: POOLS_PATH,
      nginxDefaultPath: NGINX_DEFAULT_PATH,
      statePath,
      stateMode: 0o600,
      atomicWrite: (filePath, content, mode) => atomicWriteFile(filePath, content, mode),
      backupFile: (filePath, content) => {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(path.join(DATA_DIR, `${path.basename(filePath)}.${stamp}.bak`), content, "utf8");
      },
      lock: new DirectoryLock(path.join(DATA_DIR, "runtime-config.lock")),
      validateConfig: async () => {
        await execFileAsync("docker", ["exec", "hosting-nginx", "nginx", "-t"], { timeout: 30_000 });
        await execFileAsync("docker", ["exec", phpHost, "php-fpm", "-t"], { timeout: 30_000 });
      },
      reloadNginx,
      reloadPhp,
      verifyPorts: async (ports) => verifyPortsWithRetry(ports, { host: process.env.PHP_FPM_HOST || phpHost }),
    },
  });

  process.stdout.write(
    `Static isolation applied: ${result.converted.length} route(s), ${result.removedPools.length} unused pool(s) removed`
    + `, ${result.reclassified.length} PHP site(s) reclassified`
    + `${result.skipped.length ? `, ${result.skipped.length} missing route(s) skipped` : ""}.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
