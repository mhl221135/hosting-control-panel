#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const sourceRoot = path.join(projectRoot, "global-configs-new-upd");
const outputRoot = path.resolve(process.argv[2] || path.join(projectRoot, ".nonprod-configs"));
const websiteRoots = [
  "/var/www/accessorybar.shop",
  "/var/www/arc.example.test",
  "/var/www/example.org",
  "/var/www/zdorovia-plus.pp.ua",
];

function parseMapBlock(content, variable) {
  const expression = new RegExp(`map\\s+\\$host\\s+\\$${variable}\\s*\\{([\\s\\S]*?)\\n\\}`);
  const match = content.match(expression);
  if (!match) throw new Error(`Could not find ${variable} map`);
  const entries = new Map();
  let defaultValue = "";
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim();
    const parts = line.match(/^([^\s]+)\s+(.+);$/);
    if (!parts) continue;
    if (parts[1] === "default") defaultValue = parts[2];
    else entries.set(parts[1], parts[2]);
  }
  return { entries, defaultValue };
}

function renderMap(variable, defaultValue, entries) {
  const lines = [`map $host $${variable} {`, `  default ${defaultValue};`];
  for (const [host, value] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`  ${host} ${value};`);
  }
  lines.push("}");
  return lines.join("\n");
}

function prepareSitesMap() {
  const sourcePath = path.join(sourceRoot, "nginx", "conf.d", "sites.map");
  const content = fs.readFileSync(sourcePath, "utf8");
  const roots = parseMapBlock(content, "site_root");
  const upstreams = parseMapBlock(content, "php_upstream");
  const canonicals = parseMapBlock(content, "canonical_host");
  const selectedHosts = [...roots.entries]
    .filter(([, root]) => websiteRoots.some((prefix) => root === prefix || root.startsWith(`${prefix}/`)))
    .map(([host]) => host);
  const selectedPorts = new Set(["9000"]);
  const filteredRoots = new Map();
  const filteredUpstreams = new Map();
  const filteredCanonicals = new Map();

  for (const host of selectedHosts) {
    filteredRoots.set(host, roots.entries.get(host));
    const upstream = upstreams.entries.get(host);
    if (upstream) {
      filteredUpstreams.set(host, upstream);
      const port = upstream.match(/:(\d+)$/)?.[1];
      if (port) selectedPorts.add(port);
    }
    if (canonicals.entries.has(host)) filteredCanonicals.set(host, canonicals.entries.get(host));
  }

  const output = [
    renderMap("site_root", roots.defaultValue, filteredRoots),
    renderMap("php_upstream", upstreams.defaultValue, filteredUpstreams),
    renderMap("canonical_host", canonicals.defaultValue || '""', filteredCanonicals),
    "",
  ].join("\n\n");
  fs.writeFileSync(path.join(outputRoot, "nginx", "conf.d", "sites.map"), output, "utf8");
  return selectedPorts;
}

function preparePools(selectedPorts) {
  const sourcePath = path.join(sourceRoot, "php-fpm", "pools.conf");
  const content = fs.readFileSync(sourcePath, "utf8");
  const firstSection = content.search(/^\[[^\]]+\]\s*$/m);
  const prefix = firstSection >= 0 ? content.slice(0, firstSection) : "";
  const sections = content.slice(firstSection).split(/(?=^\[[^\]]+\]\s*$)/m);
  const selected = sections.filter((section) => {
    const port = section.match(/^listen\s*=\s*(\d+)\s*$/m)?.[1];
    return port && selectedPorts.has(port);
  });
  fs.writeFileSync(
    path.join(outputRoot, "php-fpm", "pools.conf"),
    `${prefix}${selected.join("").trimEnd()}\n`,
    "utf8",
  );
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.cpSync(sourceRoot, outputRoot, { recursive: true });
const selectedPorts = prepareSitesMap();
preparePools(selectedPorts);
console.log(`Prepared non-production configs for ports: ${[...selectedPorts].sort().join(", ")}`);
