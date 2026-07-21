#!/usr/bin/env node

const { IntegrationSettings } = require("../lib/integration-settings");
const { NpmClient } = require("../lib/integrations");
const { validateDomain } = require("../lib/provisioner");

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const MARKER = "# Hosting Control provision imports";
const DIRECTIVES = `${MARKER}
client_max_body_size 8g;
client_body_timeout 1h;
proxy_request_buffering off;
proxy_connect_timeout 60s;
proxy_send_timeout 1h;
proxy_read_timeout 4h;
send_timeout 1h;`;

async function main() {
  const domain = validateDomain(process.argv[2]);
  const settings = new IntegrationSettings(DATA_DIR);
  const npm = new NpmClient(() => settings.resolved());
  const host = await npm.findHost(domain);
  if (!host) throw new Error(`NPM proxy host not found for ${domain}`);
  const existing = String(host.advanced_config || "").trim();
  const markerIndex = existing.indexOf(MARKER);
  const unmanaged = markerIndex >= 0 ? existing.slice(0, markerIndex).trim() : existing;
  const advancedConfig = [unmanaged, DIRECTIVES].filter(Boolean).join("\n\n");
  if (advancedConfig === existing) return process.stdout.write(`Large uploads are already configured for ${domain}.\n`);
  await npm.updateHost(host, {
    advanced_config: advancedConfig,
  });
  process.stdout.write(`Large uploads configured for ${domain}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
