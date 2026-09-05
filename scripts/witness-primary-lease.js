#!/usr/bin/env node
const fs = require("fs");

function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }
function secret(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600) fail("Witness token file is unsafe");
  const value = fs.readFileSync(file, "utf8").trim();
  if (value.length < 32 || value.length > 512) fail("Witness token is invalid");
  return value;
}

async function main() {
  if (process.getuid?.() !== 0) fail("Run as root");
  const config = Object.fromEntries(fs.readFileSync("/etc/hosting-control/witness-primary.env", "utf8")
    .split("\n").filter(Boolean).map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1).replace(/^'|'$/g, "")]; }));
  const role = JSON.parse(fs.readFileSync("/etc/hosting-control/role.json", "utf8"));
  if (role.role !== "primary") return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response;
  try {
    response = await fetch(config.WITNESS_LEASE_URL, {
      method: "POST", signal: controller.signal, redirect: "error",
      headers: { authorization: `Bearer ${secret(config.WITNESS_PRIMARY_TOKEN_FILE)}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, primaryServerId: role.server_id }),
    });
  } finally { clearTimeout(timer); }
  if (!response.ok) fail(`Witness returned HTTP ${response.status}`);
  const value = await response.json();
  if (value.version !== 1 || value.status !== "leased" || value.primaryServerId !== role.server_id
    || !Number.isFinite(Date.parse(value.leaseExpiresAt))) fail("Witness lease response is invalid");
  const output = "/etc/hosting-control/witness-primary-state.json";
  const temporary = `${output}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...value, checkedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, output);
}

main().catch((error) => fail(String(error?.message || error).replace(/[\r\n\t]+/g, " ").slice(0, 200)));
