#!/usr/bin/env node

const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { migrateStaticRoutes } = require("../lib/static-route-migration");

const execFileAsync = promisify(execFile);
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const SITES_MAP_PATH = process.env.SITES_MAP_PATH || "/srv/configs/nginx/conf.d/sites.map";
const POOLS_PATH = process.env.POOLS_PATH || "/srv/configs/php-fpm/pools.conf";
const NGINX_DEFAULT_PATH = process.env.NGINX_DEFAULT_PATH || "/srv/configs/nginx/conf.d/default.conf";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const before = {
    map: fs.readFileSync(SITES_MAP_PATH, "utf8"),
    pools: fs.readFileSync(POOLS_PATH, "utf8"),
    nginx: fs.readFileSync(NGINX_DEFAULT_PATH, "utf8"),
  };
  const statePath = `${DATA_DIR}/site-state.json`;
  const siteState = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { sites: {} };
  const result = migrateStaticRoutes({
    mapContent: before.map,
    poolsContent: before.pools,
    nginxContent: before.nginx,
    siteState,
  });
  const changed = result.mapContent !== before.map
    || result.poolsContent !== before.pools
    || result.nginxContent !== before.nginx;
  if (!changed) {
    process.stdout.write("Static route isolation is already current.\n");
    return;
  }
  if (dryRun) {
    process.stdout.write(
      `Static isolation preview: ${result.converted.length} route(s), ${result.removedPools.length} unused pool(s)`
      + `${result.skipped.length ? `, ${result.skipped.length} missing route(s)` : ""}.\n`
      + `Routes: ${result.converted.join(", ") || "none"}\n`
      + `Pools: ${result.removedPools.join(", ") || "none"}\n`,
    );
    return;
  }

  try {
    fs.writeFileSync(SITES_MAP_PATH, result.mapContent, "utf8");
    fs.writeFileSync(POOLS_PATH, result.poolsContent, "utf8");
    fs.writeFileSync(NGINX_DEFAULT_PATH, result.nginxContent, "utf8");
    await execFileAsync("docker", ["exec", "hosting-nginx", "nginx", "-t"], { timeout: 30_000 });
    await execFileAsync("docker", ["exec", process.env.PHP_CONTAINER || "hosting-php-fpm", "php-fpm", "-t"], { timeout: 30_000 });
    await execFileAsync("docker", ["exec", "hosting-nginx", "nginx", "-s", "reload"], { timeout: 30_000 });
    await execFileAsync("docker", [
      "exec", process.env.PHP_CONTAINER || "hosting-php-fpm", "sh", "-c", "kill -USR2 1",
    ], { timeout: 30_000 });
  } catch (error) {
    fs.writeFileSync(SITES_MAP_PATH, before.map, "utf8");
    fs.writeFileSync(POOLS_PATH, before.pools, "utf8");
    fs.writeFileSync(NGINX_DEFAULT_PATH, before.nginx, "utf8");
    await execFileAsync("docker", ["exec", "hosting-nginx", "nginx", "-s", "reload"], { timeout: 30_000 }).catch(() => {});
    await execFileAsync("docker", [
      "exec", process.env.PHP_CONTAINER || "hosting-php-fpm", "sh", "-c", "kill -USR2 1",
    ], { timeout: 30_000 }).catch(() => {});
    throw error;
  }

  process.stdout.write(
    `Static isolation applied: ${result.converted.length} route(s), ${result.removedPools.length} unused pool(s) removed`
    + `${result.skipped.length ? `, ${result.skipped.length} missing route(s) skipped` : ""}.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
