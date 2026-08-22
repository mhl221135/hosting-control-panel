#!/usr/bin/env node
const fs = require("fs");
const { SiteState } = require("../lib/site-state");
const { annotateSiteAliases, parseSitesMap } = require("../lib/runtime-config");
const { WordPressCacheControl } = require("../lib/wordpress-cache-control");
const { setRedisSelectiveFlush } = require("../lib/provisioner");

const dataDir = process.env.DATA_DIR || "/app/data";
const websitesRoot = process.env.WEBSITES_ROOT || "/srv/websites";
const sitesMapPath = process.env.SITES_MAP_PATH || "/srv/configs/nginx/conf.d/sites.map";
const cacheMapPath = process.env.CACHE_MAP_PATH || "/srv/configs/nginx/conf.d/cache.map";
const cacheControlStatePath = process.env.WP_CACHE_CONTROL_STATE_PATH || "/srv/configs/wp/wordpress-cache-control.json";
const state = new SiteState(dataDir, cacheMapPath);
const manager = new WordPressCacheControl({ dataDir, websitesRoot, statePath: cacheControlStatePath });
const sites = annotateSiteAliases(Object.values(parseSitesMap(fs.readFileSync(sitesMapPath, "utf8")).hosts))
  .filter((site) => !site.isAlias && state.get(site.host).siteType === "wordpress")
  .map((site) => ({
    host: site.host,
    directory: String(site.root || "").replace(/^\/var\/www\//, "").replace(/\/$/, ""),
    redis: state.get(site.host).redis,
  }));
const result = manager.installMany(sites);
(async () => {
  for (const item of result.results.filter((entry) => entry.ok)) {
    const site = sites.find((entry) => entry.host === item.domain);
    if (!site?.redis) continue;
    try { await setRedisSelectiveFlush(site.directory); }
    catch (error) { item.ok = false; item.message = `Selective Redis flush configuration failed: ${error.message}`; }
  }
  result.completed = result.results.filter((item) => item.ok).length;
  result.ok = result.completed === result.total;
  process.stdout.write(`${JSON.stringify({ total: result.total, completed: result.completed, failed: result.total - result.completed })}\n`);
  if (!result.ok) {
    for (const item of result.results.filter((entry) => !entry.ok)) process.stderr.write(`${item.domain}: ${item.message}\n`);
    process.exitCode = 1;
  }
})().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
