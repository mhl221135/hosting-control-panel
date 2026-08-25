#!/usr/bin/env node

const fs = require("fs");
const net = require("net");
const { IntegrationSettings } = require("../lib/integration-settings");
const { CloudflareClient } = require("../lib/integrations");

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const INGRESS_TYPES = new Set(["A", "AAAA", "CNAME"]);

function options(argv) {
  const result = { mode: "", ip: "", confirm: "", map: "/srv/configs/nginx/conf.d/sites.map", dataDir: "/app/data" };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--preview", "--apply"].includes(value)) result.mode = value.slice(2);
    else if (["--ip", "--confirm", "--map", "--data-dir"].includes(value)) {
      index += 1;
      if (!argv[index]) throw new Error(`${value} requires a value`);
      result[value.slice(2).replace("data-dir", "dataDir")] = argv[index];
    } else throw new Error(`Unknown option: ${value}`);
  }
  if (!result.mode || net.isIP(result.ip) !== 4) throw new Error("Use --preview or --apply with a valid --ip IPv4 address");
  if (result.mode === "apply" && result.confirm !== "RECONCILE-HOST-DNS") {
    throw new Error("Apply requires --confirm RECONCILE-HOST-DNS");
  }
  return result;
}

function hostsFromMap(content) {
  return [...new Set(String(content).split("\n").map((line) => {
    const match = line.match(/^\s*([^\s#]+)\s+\/var\/www\//);
    const host = String(match?.[1] || "").toLowerCase();
    return HOST.test(host) ? host : "";
  }).filter(Boolean))].sort();
}

function zoneForHost(zones, host) {
  return zones.filter((zone) => host === zone.name || host.endsWith(`.${zone.name}`))
    .sort((left, right) => right.name.length - left.name.length)[0] || null;
}

async function mapLimit(values, limit, task) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await task(values[index]);
    }
  }));
  return output;
}

async function reconcileHost(client, zone, host, ip, apply) {
  const response = await client.request(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=100`);
  const ingress = (response.result || []).filter((record) => INGRESS_TYPES.has(String(record.type)) && record.name === host);
  const exact = ingress.length === 1 && ingress[0].type === "A" && ingress[0].content === ip
    && ingress[0].proxied === true;
  if (!apply || exact) return { host, status: exact ? "current" : "change", previous: ingress.map((record) => `${record.type}:${record.content}`) };

  const payload = client.recordPayload(host, {
    type: "A", name: host, content: ip, ttl: 1, proxied: true,
    comment: "Managed by Hosting Control DNS reconciliation",
  });
  const existingA = ingress.find((record) => record.type === "A");
  for (const record of ingress.filter((item) => item.id !== existingA?.id)) {
    await client.request(`/zones/${zone.id}/dns_records/${record.id}`, { method: "DELETE" });
  }
  if (existingA) {
    await client.request(`/zones/${zone.id}/dns_records/${existingA.id}`, { method: "PUT", body: JSON.stringify(payload) });
  } else {
    await client.request(`/zones/${zone.id}/dns_records`, { method: "POST", body: JSON.stringify(payload) });
  }
  return { host, status: "changed", previous: ingress.map((record) => `${record.type}:${record.content}`) };
}

async function main() {
  const input = options(process.argv);
  const hosts = hostsFromMap(fs.readFileSync(input.map, "utf8"));
  if (!hosts.length) throw new Error("No website hostnames were found in the routing map");
  const settings = new IntegrationSettings(input.dataDir);
  const client = new CloudflareClient(() => settings.resolved());
  const zones = (await client.zones()).map((zone) => ({ id: String(zone.id), name: String(zone.name).toLowerCase() }));
  const results = await mapLimit(hosts, 8, async (host) => {
    const zone = zoneForHost(zones, host);
    if (!zone) return { host, status: "unmanaged" };
    try { return await reconcileHost(client, zone, host, input.ip, input.mode === "apply"); }
    catch (error) { return { host, status: "error", error: String(error.message || error).slice(0, 160) }; }
  });
  const summary = Object.fromEntries(["current", "change", "changed", "unmanaged", "error"]
    .map((status) => [status, results.filter((item) => item.status === status).length]));
  process.stdout.write(`${JSON.stringify({ mode: input.mode, ip: input.ip, total: hosts.length, summary, results }, null, 2)}\n`);
  if (summary.error) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${String(error.message || error).slice(0, 300)}\n`);
  process.exitCode = 1;
});

module.exports = { hostsFromMap, options, zoneForHost };
