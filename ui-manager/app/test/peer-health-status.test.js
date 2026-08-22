const assert = require("node:assert/strict");
const test = require("node:test");
const { PeerHealthStatus, configuredUrl } = require("../lib/peer-health-status");

test("requires a bounded credential-free HTTPS peer URL", () => {
  assert.equal(configuredUrl("https://peer.example.com/health"), "https://peer.example.com/health");
  assert.throws(() => configuredUrl("http://peer.example.com/health"), /HTTPS/);
  assert.throws(() => configuredUrl("https://user:pass@peer.example.com/health"), /credentials/);
  assert.throws(() => configuredUrl("https://peer.example.com/health?token=value"), /query/);
});

test("reports a matching bounded peer health response", async () => {
  let tick = 1000;
  const status = new PeerHealthStatus({
    url: "https://peer.example.com/health",
    expectedServerId: "primary-1",
    token: "x".repeat(32),
    now: () => { tick += 7; return tick; },
    fetch: async (_url, options) => {
      assert.equal(options.headers.authorization, `Bearer ${"x".repeat(32)}`);
      return {
        ok: true,
        json: async () => ({ ok: true, role: "primary", serverId: "primary-1", failoverStatus: "healthy", recoveryId: null, ignored: "secret" }),
      };
    },
  });
  assert.deepEqual(await status.read(), {
    configured: true,
    reachable: true,
    authenticated: true,
    identityMatched: true,
    expectedServerId: "primary-1",
    serverId: "primary-1",
    role: "primary",
    failoverStatus: "healthy",
    recoveryId: null,
    latencyMs: 7,
    checkedAt: "1970-01-01T00:00:01.007Z",
  });
});

test("fails closed on identity mismatch and network failure", async () => {
  const mismatch = new PeerHealthStatus({
    url: "https://peer.example.com/health",
    expectedServerId: "primary-1",
    token: "x".repeat(32),
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, role: "primary", serverId: "other" }) }),
  });
  assert.equal((await mismatch.read()).identityMatched, false);
  const failed = new PeerHealthStatus({
    url: "https://peer.example.com/health",
    expectedServerId: "primary-1",
    token: "x".repeat(32),
    fetch: async () => { throw new Error("offline\nprivate detail"); },
  });
  const result = await failed.read();
  assert.equal(result.reachable, false);
  assert.equal(result.identityMatched, false);
  assert.equal(result.error.includes("\n"), false);
});

test("is explicitly unconfigured without both settings", async () => {
  assert.equal((await new PeerHealthStatus().read()).configured, false);
});
