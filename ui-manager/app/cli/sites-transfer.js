#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const { IntegrationSettings } = require("../lib/integration-settings");
const { CloudflareClient, NpmClient } = require("../lib/integrations");
const { MigrationManager, newestDatabaseDump, validateImportPlan, validateIpv4, validateManifest } = require("../lib/migration-manager");
const { SiteState } = require("../lib/site-state");
const { validateDomain } = require("../lib/provisioner");

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const WEBSITES_ROOT = process.env.WEBSITES_ROOT || "/srv/websites";
const EXPORTS_ROOT = process.env.EXPORTS_ROOT || "/srv/exports";
const IMPORTS_ROOT = process.env.IMPORTS_ROOT || "/srv/imports";
const SITES_MAP_PATH = process.env.SITES_MAP_PATH || "/srv/configs/nginx/conf.d/sites.map";
const POOLS_PATH = process.env.POOLS_PATH || "/srv/configs/php-fpm/pools.conf";
const CACHE_MAP_PATH = process.env.CACHE_MAP_PATH || "/srv/configs/nginx/conf.d/cache.map";

const settings = new IntegrationSettings(DATA_DIR);
const npm = new NpmClient(() => settings.resolved());
const cloudflare = new CloudflareClient(() => settings.resolved());
const siteState = new SiteState(DATA_DIR, CACHE_MAP_PATH);
const manager = new MigrationManager({
  dataDir: DATA_DIR,
  exportsRoot: EXPORTS_ROOT,
  websitesRoot: WEBSITES_ROOT,
  sitesMapPath: SITES_MAP_PATH,
  poolsPath: POOLS_PATH,
  mysqlContainer: process.env.MYSQL_CONTAINER || "hosting-db",
  phpContainer: process.env.PHP_CONTAINER || "hosting-php-fpm",
  npm,
  cloudflare,
  siteState,
});

const terminal = readline.createInterface({ input: stdin, output: stdout });

async function prompt(label, defaultValue = "") {
  const answer = (await terminal.question(`${label}${defaultValue ? ` [${defaultValue}]` : ""}: `)).trim();
  return answer || defaultValue;
}

async function confirm(label, defaultValue = true) {
  const marker = defaultValue ? "Y/n" : "y/N";
  const answer = (await terminal.question(`${label} [${marker}]: `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

function sourceInsideImports(value) {
  const source = path.resolve(value);
  const root = path.resolve(IMPORTS_ROOT);
  if (!source.startsWith(`${root}${path.sep}`) || !fs.statSync(source).isDirectory()) {
    throw new Error(`Import source must be a staged directory below ${IMPORTS_ROOT}`);
  }
  return source;
}

async function detectWanIp() {
  try {
    const response = await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(10_000) });
    const match = (await response.text()).match(/^ip=(.+)$/m);
    return match ? validateIpv4(match[1]) : "";
  } catch {
    return "";
  }
}

async function exportSites() {
  const configured = manager.primarySites();
  if (!configured.length) throw new Error("No configured primary websites were found");
  stdout.write(`Configured primary websites:\n${configured.map((site) => `  - ${site.host}`).join("\n")}\n`);
  const selection = await prompt("Domains to export, comma separated (blank exports all)");
  const domains = selection ? selection.split(",").map((item) => item.trim()).filter(Boolean) : [];
  if (!await confirm(`Create export for ${domains.length || configured.length} website(s)`)) return;
  const result = await manager.exportAll(domains);
  stdout.write(`\nExport completed: ${result.directory}\nManifest: ${path.join(result.directory, "manifest.json")}\n`);
}

async function manualManifest(sourceDirectory) {
  const discovered = manager.discoverCopiedSites();
  if (!discovered.length) throw new Error("No unconfigured wp-config.php files were found under the websites directory");
  const sites = [];
  for (const candidate of discovered) {
    const configuredDatabase = await manager.wordpressDatabase(candidate.websitePath);
    const dump = newestDatabaseDump(sourceDirectory, configuredDatabase);
    stdout.write(`\nWebsite path: ${candidate.websitePath}\nDatabase in wp-config.php: ${configuredDatabase}\nDump: ${dump || "not found"}\n`);
    if (!dump) continue;
    if (!await confirm("Import this website", true)) continue;
    const basename = path.posix.basename(candidate.websitePath).toLowerCase();
    let domain = "";
    while (!domain) {
      try {
        domain = validateDomain(await prompt("Primary domain", basename.includes(".") ? basename : ""));
      } catch (error) {
        stdout.write(`${error.message}\n`);
      }
    }
    const aliasValue = await prompt("Aliases, comma separated (optional)");
    const aliases = aliasValue ? aliasValue.split(",").map((item) => validateDomain(item.trim())) : [];
    const poolTier = await prompt("PHP profile: low, medium or high", "medium");
    sites.push({
      domain,
      aliases,
      canonicalAliases: aliases,
      websitePath: candidate.websitePath,
      database: configuredDatabase,
      databaseDump: path.basename(dump),
      poolTier,
      state: { opcache: true, redis: false, fastcgiCache: false, backupEnabled: true },
    });
  }
  return validateManifest({ version: 1, type: "hosting-sites-export", createdAt: new Date().toISOString(), sites });
}

async function manifestFromImportPlan(sourceDirectory, importPlan) {
  const plan = validateImportPlan(importPlan);
  const sites = [];
  for (const site of plan.sites) {
    const configuredDatabase = await manager.wordpressDatabase(site.websitePath);
    const dump = newestDatabaseDump(sourceDirectory, configuredDatabase);
    if (!dump) {
      throw new Error(`No .sql.gz dump found for ${site.domain} database ${configuredDatabase}`);
    }
    sites.push({
      ...site,
      database: configuredDatabase,
      databaseDump: path.basename(dump),
    });
  }
  return validateManifest({
    version: 1,
    type: "hosting-sites-export",
    createdAt: new Date().toISOString(),
    sites,
  });
}

async function importSites(sourceArgument) {
  const sourceDirectory = sourceInsideImports(sourceArgument || await prompt("Staged import directory", IMPORTS_ROOT));
  const manifestPath = path.join(sourceDirectory, "manifest.json");
  const importPlanPath = path.join(sourceDirectory, "import-sites.json");
  const fromExport = fs.existsSync(manifestPath);
  const fromImportPlan = !fromExport && fs.existsSync(importPlanPath);
  let manifest;
  if (fromExport) manifest = manager.readManifest(sourceDirectory);
  else if (fromImportPlan) {
    const importPlan = JSON.parse(fs.readFileSync(importPlanPath, "utf8"));
    manifest = await manifestFromImportPlan(sourceDirectory, importPlan);
  } else manifest = await manualManifest(sourceDirectory);
  if (!manifest.sites.length) throw new Error("No websites were selected for import");
  stdout.write(`\nImport plan:\n${manifest.sites.map((site) => `  - ${site.domain} -> ${site.websitePath} (${site.database})`).join("\n")}\n`);
  const detectedIp = await detectWanIp();
  const wanIp = validateIpv4(await prompt("Current server WAN IPv4", detectedIp));
  const updateDns = await confirm("Create or replace Cloudflare host records with A records", true);
  const proxied = updateDns ? await confirm("Enable Cloudflare proxy", true) : false;
  const issueSsl = await confirm("Create NPM hosts and request Let's Encrypt SSL", true);
  if (!await confirm("Start import", false)) return;
  const result = await manager.importSites({
    sourceDirectory,
    manifest,
    useExistingFiles: manifest.sites.every((site) => !site.websiteArchive),
    wanIp,
    updateDns,
    proxied,
    issueSsl,
  });
  stdout.write(`\nImport completed${result.ok ? "" : " with warnings"}.\n`);
  for (const site of result.results) {
    stdout.write(`  ${site.domain}: pool port ${site.port}${site.database ? `, database ${site.database}` : ", no database"}\n`);
    site.warnings.forEach((warning) => stdout.write(`    WARNING: ${warning}\n`));
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "export") await exportSites();
  else if (command === "import") await importSites(process.argv[3]);
  else throw new Error("Usage: sites-transfer.js export | import [staged-directory]");
}

main()
  .catch((error) => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => terminal.close());
