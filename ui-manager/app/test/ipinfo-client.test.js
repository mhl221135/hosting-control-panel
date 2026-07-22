const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { IpinfoClient, normalizeResponse, validateLookupIp } = require("../lib/ipinfo-client");

test("rejects internal, reserved, Cloudflare edge, and configured server addresses", () => {
  for (const ip of ["127.0.0.1", "192.168.1.2", "203.0.113.8", "104.16.1.1", "2606:4700::1", "::ffff:192.168.1.2"]) {
    assert.throws(() => validateLookupIp(ip), /cannot be enriched/);
  }
  assert.throws(() => validateLookupIp("8.8.8.8", ["8.8.8.8"]), /cannot be enriched/);
  assert.equal(validateLookupIp("1.1.1.1"), "1.1.1.1");
});

test("normalizes legacy and current response fields without retaining raw data", () => {
  assert.deepEqual(normalizeResponse({
    hostname: "example.net", city: "Kyiv", region: "Kyiv", country: "UA",
    org: "AS64500 Example Org", privacy: { vpn: true }, extra: "discarded",
  }, "8.8.8.8"), {
    ip: "8.8.8.8", hostname: "example.net", city: "Kyiv", region: "Kyiv", country: "UA",
    asn: "AS64500", organization: "Example Org", network: "",
    indicators: { hosting: null, anonymous: null, proxy: null, vpn: true, tor: null, relay: null },
  });
});

test("caches successful lookups for 24 hours and stores no token or raw response", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipinfo-test-"));
  let requests = 0;
  const client = new IpinfoClient({
    dataDir,
    settings: () => ({ ipinfoToken: "secret-token" }),
    now: () => Date.parse("2026-07-22T12:00:00Z"),
    fetch: async () => {
      requests += 1;
      return { ok: true, json: async () => ({ country: "US", org: "AS15169 Google LLC", raw: "discard-me" }) };
    },
  });
  assert.equal((await client.lookup("8.8.8.8")).cached, false);
  assert.equal((await client.lookup("8.8.8.8")).cached, true);
  assert.equal(requests, 1);
  const stored = fs.readFileSync(path.join(dataDir, "ipinfo-cache.json"), "utf8");
  assert.doesNotMatch(stored, /secret-token|discard-me/);
  client.clear();
  assert.equal(fs.existsSync(path.join(dataDir, "ipinfo-cache.json")), false);
});
