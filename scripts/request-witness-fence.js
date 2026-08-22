#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { verifyWitnessReceipt } = require("../ui-manager/app/lib/fence-receipt");

function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }
function rootSecret(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600) fail(`${file} must be a root-owned mode-600 regular file`);
  const value = fs.readFileSync(file, "utf8").trim();
  if (value.length < 32 || value.length > 512) fail(`${file} is invalid`);
  return value;
}

async function main() {
  if (process.getuid?.() !== 0) fail("Run as root");
  const configPath = "/etc/hosting-control/external-witness.env";
  const config = Object.fromEntries(fs.readFileSync(configPath, "utf8").split("\n").filter(Boolean).map((line) => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1).replace(/^'|'$/g, "")];
  }));
  const recoveryId = process.argv[2];
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(recoveryId || "")) fail("Recovery identifier is invalid");
  const url = new URL(config.WITNESS_URL || "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail("Witness URL is invalid");
  const token = rootSecret(config.WITNESS_TOKEN_FILE);
  const signingKey = rootSecret(config.WITNESS_SIGNING_KEY_FILE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let response;
  try {
    response = await fetch(url, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ version: 1, primaryServerId: config.WITNESS_PRIMARY_SERVER_ID, recoveryId }),
    });
  } finally { clearTimeout(timer); }
  if (!response.ok) fail(`Witness returned HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 8192) fail("Witness response is too large");
  const receipt = verifyWitnessReceipt(JSON.parse(text), signingKey, {
    primaryServerId: config.WITNESS_PRIMARY_SERVER_ID, recoveryId,
  });
  const output = "/etc/hosting-control/primary-fence-receipt.json";
  const temporary = `${output}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, output);
  process.stdout.write(`Verified external fencing receipt for ${receipt.primaryServerId} at ${recoveryId}.\n`);
}

main().catch((error) => fail(String(error?.name === "AbortError" ? "Witness request timed out" : error?.message || error).replace(/[\r\n\t]+/g, " ").slice(0, 240)));
