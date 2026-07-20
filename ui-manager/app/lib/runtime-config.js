function sanitizeSectionName(host) {
  return String(host || "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "pool";
}

function parseSitesMap(content, defaultUpstream = "hosting-php-fpm:9000") {
  const rootBlockMatch = content.match(/map\s+\$host\s+\$site_root\s*\{([\s\S]*?)\n\}/);
  const upstreamBlockMatch = content.match(/map\s+\$host\s+\$php_upstream\s*\{([\s\S]*?)\n\}/);
  const canonicalBlockMatch = content.match(/map\s+\$host\s+\$canonical_host\s*\{([\s\S]*?)\n\}/);
  if (!rootBlockMatch || !upstreamBlockMatch) {
    throw new Error("Could not parse sites.map. Expected both map blocks.");
  }
  const parseBlock = (block) => {
    const entries = {};
    let defaultValue = "";
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([^\s]+)\s+(.+);$/);
      if (!match) continue;
      if (match[1] === "default") defaultValue = match[2];
      else entries[match[1]] = match[2];
    }
    return { entries, defaultValue };
  };
  const roots = parseBlock(rootBlockMatch[1]);
  const upstreams = parseBlock(upstreamBlockMatch[1]);
  const canonicals = canonicalBlockMatch ? parseBlock(canonicalBlockMatch[1]) : { entries: {}, defaultValue: '\"\"' };
  const hosts = {};
  const allHosts = new Set([...Object.keys(roots.entries), ...Object.keys(upstreams.entries), ...Object.keys(canonicals.entries)]);
  for (const host of allHosts) {
    const upstream = upstreams.entries[host] || "";
    const portMatch = upstream.match(/:(\d+)$/);
    hosts[host] = {
      host,
      root: roots.entries[host] || "",
      upstream,
      port: portMatch ? Number(portMatch[1]) : null,
      canonicalTo: canonicals.entries[host] || "",
    };
  }
  return {
    defaultRoot: roots.defaultValue || "/var/www/_default",
    defaultUpstream,
    defaultCanonical: canonicals.defaultValue || '\"\"',
    hosts,
  };
}

function renderSitesMap(parsed) {
  const hosts = Object.keys(parsed.hosts).sort();
  const rootLines = [`map $host $site_root {`, `  default ${parsed.defaultRoot};`];
  const upstreamLines = [`map $host $php_upstream {`, `  default ${parsed.defaultUpstream};`];
  const canonicalLines = [`map $host $canonical_host {`, `  default ${parsed.defaultCanonical || '\"\"'};`];
  for (const host of hosts) {
    const site = parsed.hosts[host];
    if (site.root) rootLines.push(`  ${host} ${site.root};`);
    if (site.upstream) upstreamLines.push(`  ${host} ${site.upstream};`);
    if (site.canonicalTo) canonicalLines.push(`  ${host} ${site.canonicalTo};`);
  }
  rootLines.push("}");
  upstreamLines.push("}");
  canonicalLines.push("}");
  return `${rootLines.join("\n")}\n\n${upstreamLines.join("\n")}\n\n${canonicalLines.join("\n")}\n`;
}

function parsePools(content) {
  const prefix = [];
  const sections = {};
  const sectionOrder = [];
  let current = null;
  for (const raw of content.split("\n")) {
    const sectionMatch = raw.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      current = sectionMatch[1];
      if (!sections[current]) {
        sections[current] = {};
        sectionOrder.push(current);
      }
      continue;
    }
    if (!current) {
      prefix.push(raw);
      continue;
    }
    const settingMatch = raw.match(/^\s*([^=;#]+?)\s*=\s*(.*?)\s*$/);
    if (settingMatch) sections[current][settingMatch[1].trim()] = settingMatch[2].trim();
  }
  const byPort = {};
  for (const name of sectionOrder) {
    const port = Number(sections[name].listen);
    if (Number.isFinite(port)) byPort[port] = { name, settings: sections[name] };
  }
  return { prefix, sections, sectionOrder, byPort };
}

function renderPools(parsed) {
  const output = [];
  const prefix = parsed.prefix.join("\n").replace(/\s+$/, "");
  if (prefix) output.push(prefix);
  for (const name of parsed.sectionOrder) {
    const settings = parsed.sections[name];
    if (!settings) continue;
    output.push("", `[${name}]`);
    for (const [key, value] of Object.entries(settings)) output.push(`${key} = ${value}`);
  }
  output.push("");
  return output.join("\n");
}

module.exports = { parsePools, parseSitesMap, renderPools, renderSitesMap, sanitizeSectionName };
