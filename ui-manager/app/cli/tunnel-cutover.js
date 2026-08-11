#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  CloudflareCutoverApi,
  TunnelCutover,
  decodeTunnelToken,
  normalizeHosts,
} = require("../lib/tunnel-cutover");

function usage() {
  process.stderr.write(`Usage: tunnel-cutover.js [options]\n\n`);
  process.stderr.write(`  --preview                 Print the exact tunnel and DNS plan\n`);
  process.stderr.write(`  --apply                   Apply the reviewed cutover\n`);
  process.stderr.write(`  --rollback                Restore the recorded tunnel and DNS state\n`);
  process.stderr.write(`  --hosts-file PATH         One hostname per line (required except rollback)\n`);
  process.stderr.write(`  --confirm TEXT            SWITCH-TUNNEL-INGRESS or ROLLBACK-TUNNEL-INGRESS\n`);
}

function argumentsFrom(argv) {
  const output = { mode: "", hostsFile: "", confirmation: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--preview", "--apply", "--rollback"].includes(value)) output.mode = value.slice(2);
    else if (value === "--hosts-file") output.hostsFile = argv[++index] || "";
    else if (value === "--confirm") output.confirmation = argv[++index] || "";
    else if (["-h", "--help"].includes(value)) return { help: true };
    else throw new Error(`Unknown argument: ${value}`);
  }
  return output;
}

function envPath(name, fallback) {
  const value = String(process.env[name] || fallback || "");
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function hostsFrom(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error("--hosts-file must be an absolute path");
  const values = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter(Boolean);
  return normalizeHosts(values);
}

function tunnelIdentity() {
  const configuredAccount = String(process.env.CLOUDFLARE_ACCOUNT_ID || "");
  const configuredTunnel = String(process.env.CLOUDFLARED_TUNNEL_ID || "");
  if (configuredAccount && configuredTunnel) return { accountId: configuredAccount, tunnelId: configuredTunnel };
  const tokenFile = envPath("CLOUDFLARED_TUNNEL_TOKEN_FILE", "/run/secrets/cloudflared_token");
  return decodeTunnelToken(fs.readFileSync(tokenFile, "utf8"));
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (!options.mode) throw new Error("Select --preview, --apply, or --rollback");
  if (options.mode !== "rollback" && !options.hostsFile) throw new Error("--hosts-file is required");
  const managementToken = String(process.env.CLOUDFLARE_TUNNEL_API_TOKEN || "");
  const { accountId, tunnelId } = tunnelIdentity();
  const machineState = envPath("HOSTING_MACHINE_STATE_DIR", "/etc/hosting-control");
  const cutover = new TunnelCutover({
    api: new CloudflareCutoverApi({ token: managementToken }),
    accountId,
    tunnelId,
    service: process.env.CLOUDFLARED_WEBSITE_SERVICE || "http://hosting-nginx:80",
    statePath: path.join(machineState, "tunnel-cutover.json"),
    rolePath: path.join(machineState, "role.json"),
    promotionPath: path.join(machineState, "promotion-state.json"),
  });
  let result;
  if (options.mode === "preview") result = cutover.publicPlan(await cutover.plan(hostsFrom(options.hostsFile)));
  else if (options.mode === "apply") result = await cutover.apply(hostsFrom(options.hostsFile), options.confirmation);
  else result = await cutover.rollback(options.confirmation);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error.message || error).slice(0, 500)}\n`);
  process.exitCode = 1;
});
