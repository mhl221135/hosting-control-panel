const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  StatsCollector,
  parseAccessLogs,
  parseDockerStats,
  parsePhpPools,
  parseRedisInfo,
} = require("../lib/stats-collector");

test("parses Docker, PHP-FPM, and Redis snapshots", () => {
  const containers = parseDockerStats(JSON.stringify({
    Name: "hosting-ui",
    CPUPerc: "1.25%",
    MemPerc: "0.50%",
    MemUsage: "80MiB / 16GiB",
    NetIO: "1MB / 2MB",
    BlockIO: "3MB / 4MB",
    PIDs: "12",
  }));
  assert.equal(containers[0].cpuPercent, 1.25);
  assert.equal(containers[0].pids, 12);

  const pools = parsePhpPools([
    "PID %CPU %MEM RSS ELAPSED COMMAND",
    "101 2.5 0.4 12000 00:10 php-fpm: pool example_com",
    "102 1.5 0.3 8000 00:05 php-fpm: pool example_com",
    "103 0.1 0.1 5000 00:30 php-fpm: master process (/usr/local/etc/php-fpm.conf)",
  ].join("\n"));
  assert.deepEqual(pools[0], {
    name: "example_com",
    workers: 2,
    cpuPercent: 4,
    memoryPercent: 0.7,
    rssBytes: 20_480_000,
  });

  const redis = parseRedisInfo([
    "used_memory:1048576",
    "used_memory_human:1.00M",
    "maxmemory:1073741824",
    "maxmemory_human:1.00G",
    "connected_clients:3",
    "instantaneous_ops_per_sec:21",
    "keyspace_hits:90",
    "keyspace_misses:10",
    "evicted_keys:2",
    "db0:keys=14,expires=2,avg_ttl=1000",
  ].join("\n"));
  assert.equal(redis.hitRate, 90);
  assert.equal(redis.keys, 14);
  assert.equal(redis.evictedKeys, 2);
});

test("parses the NPM access log format into recent traffic rankings", () => {
  const traffic = parseAccessLogs([
    [
      '[21/Jul/2026:03:23:25 +0000] - 200 200 - GET https example.com "/shop" [Client 203.0.113.9] [Length 1389] [Gzip -] [Sent-to example] "Agent" "-"',
      '[21/Jul/2026:03:23:26 +0000] - 404 404 - GET https example.com "/missing" [Client 203.0.113.9] [Length 100] [Gzip -] [Sent-to example] "Agent" "-"',
      '[21/Jul/2026:03:23:27 +0000] - 200 200 - POST https example.com "/checkout" [Client 198.51.100.2] [Length 250] [Gzip -] [Sent-to example] "Agent" "-"',
    ].join("\n"),
  ]);
  assert.equal(traffic.requests, 3);
  assert.equal(traffic.bytes, 1739);
  assert.equal(traffic.statusGroups["2xx"], 2);
  assert.equal(traffic.statusGroups["4xx"], 1);
  assert.deepEqual(traffic.topIps[0], { ip: "203.0.113.9", requests: 2 });
});

test("caches runtime snapshots briefly and website disk scans longer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-stats-test-"));
  const websitesRoot = path.join(root, "websites");
  const logsRoot = path.join(root, "logs");
  fs.mkdirSync(path.join(websitesRoot, "example.com"), { recursive: true });
  fs.mkdirSync(logsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(logsRoot, "proxy-host-4_access.log"),
    '[21/Jul/2026:03:23:25 +0000] - 200 200 - GET https example.com "/" [Client 203.0.113.9] [Length 100] [Gzip -] [Sent-to example] "Agent" "-"\n',
  );
  let now = 1000;
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    const command = args.join(" ");
    if (file === "du") return "2048\t/path\n";
    if (command.startsWith("ps -a")) return "hosting-ui\nhosting-php-fpm\n";
    if (command.startsWith("stats ")) return '{"Name":"hosting-ui","CPUPerc":"1%","MemPerc":"1%","MemUsage":"1MiB / 1GiB","PIDs":"2"}\n';
    if (command.startsWith("top ")) return "PID %CPU %MEM RSS ELAPSED COMMAND\n1 1.0 0.1 1024 00:01 php-fpm: pool example_com\n";
    if (command.includes("redis-cli")) return "used_memory:100\nused_memory_human:100B\nkeyspace_hits:1\nkeyspace_misses:0\n";
    if (command.includes("du -sk")) return "512\t/var/cache/nginx/fastcgi\n";
    throw new Error(`Unexpected command: ${file} ${command}`);
  };
  const collector = new StatsCollector({ websitesRoot, npmLogsRoot: logsRoot, exec, now: () => now });
  try {
    const first = await collector.runtime();
    const callCount = calls.length;
    const second = await collector.runtime();
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(calls.length, callCount);

    const site = await collector.site({ domain: "example.com", directory: "example.com", npmHostIds: [4] });
    const siteCallCount = calls.length;
    const cachedSite = await collector.site({ domain: "example.com", directory: "example.com", npmHostIds: [4] });
    assert.equal(site.diskBytes, 2 * 1024 * 1024);
    assert.equal(site.traffic.requests, 1);
    assert.equal(cachedSite.cached, true);
    assert.equal(calls.length, siteCallCount);

    now += 31_000;
    await collector.runtime();
    assert.ok(calls.length > siteCallCount);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
