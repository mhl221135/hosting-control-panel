#!/usr/bin/env node

const { IntegrationSettings } = require("../lib/integration-settings");
const { NpmClient } = require("../lib/integrations");
const { validateDomain } = require("../lib/provisioner");

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const MARKER = "# Hosting Control provision imports";
const DIRECTIVES = `${MARKER}\nclient_max_body_size 8g;\nproxy_request_buffering off;`;

async function main() {
  const domain = validateDomain(process.argv[2]);
  const settings = new IntegrationSettings(DATA_DIR);
  const npm = new NpmClient(() => settings.resolved());
  const host = await npm.findHost(domain);
  if (!host) throw new Error(`NPM proxy host not found for ${domain}`);
  const existing = String(host.advanced_config || "").trim();
  if (existing.includes(MARKER)) {
    process.stdout.write(`Large uploads are already configured for ${domain}.\n`);
    return;
  }
  await npm.updateHost(host, {
    advanced_config: [existing, DIRECTIVES].filter(Boolean).join("\n\n"),
  });
  process.stdout.write(`Large uploads configured for ${domain}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
