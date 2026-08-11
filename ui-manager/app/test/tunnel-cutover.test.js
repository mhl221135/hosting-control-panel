const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  TunnelCutover,
  decodeTunnelToken,
  desiredTunnelConfig,
  normalizeHosts,
} = require("../lib/tunnel-cutover");

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TUNNEL = "01234567-89ab-4cde-8f01-23456789abcd";

function fixture(role = "primary") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-cutover-"));
  const rolePath = path.join(directory, "role.json");
  const promotionPath = path.join(directory, "promotion-state.json");
  const statePath = path.join(directory, "tunnel-cutover.json");
  fs.writeFileSync(rolePath, JSON.stringify({ version: 1, role, server_id: "replica-1" }));
  fs.writeFileSync(promotionPath, JSON.stringify({ version: 1, status: "local-primary", public_ingress_cutover: false }));
  return { directory, rolePath, promotionPath, statePath };
}

class FakeApi {
  constructor() {
    this.config = { ingress: [{ hostname: "panel.example.com", service: "http://hosting-ui:8687" }, { service: "http_status:404" }] };
    this.records = new Map([
      ["example.com", [{ id: "old-a", type: "A", name: "example.com", content: "192.0.2.10", ttl: 1, proxied: true }]],
    ]);
    this.updatedConfigs = [];
    this.failNextCreate = false;
  }

  async zones() { return [{ id: "zone-1", name: "example.com" }]; }
  async tunnelConfig() { return { config: structuredClone(this.config) }; }
  async updateTunnelConfig(accountId, tunnelId, config) {
    assert.equal(accountId, ACCOUNT);
    assert.equal(tunnelId, TUNNEL);
    this.config = structuredClone(config);
    this.updatedConfigs.push(structuredClone(config));
  }
  async dnsRecords(zoneId, hostname) {
    assert.equal(zoneId, "zone-1");
    return structuredClone(this.records.get(hostname) || []);
  }
  async deleteDnsRecord(zoneId, recordId) {
    for (const [hostname, records] of this.records) {
      this.records.set(hostname, records.filter((record) => record.id !== recordId));
    }
  }
  async createDnsRecord(zoneId, payload) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("simulated DNS failure");
    }
    const records = this.records.get(payload.name) || [];
    records.push({ id: `new-${records.length}`, ...structuredClone(payload) });
    this.records.set(payload.name, records);
  }
}

function manager(api, files) {
  return new TunnelCutover({
    api,
    accountId: ACCOUNT,
    tunnelId: TUNNEL,
    statePath: files.statePath,
    rolePath: files.rolePath,
    promotionPath: files.promotionPath,
    now: () => "2026-08-11T08:00:00.000Z",
  });
}

test("decodes the connector token without retaining its secret", () => {
  const token = Buffer.from(JSON.stringify({ a: ACCOUNT, t: TUNNEL, s: "private" })).toString("base64url");
  assert.deepEqual(decodeTunnelToken(token), { accountId: ACCOUNT, tunnelId: TUNNEL });
});

test("normalizes and bounds explicit host selections", () => {
  assert.deepEqual(normalizeHosts(["WWW.Example.com", "www.example.com", "example.com"]), ["example.com", "www.example.com"]);
  assert.throws(() => normalizeHosts(["not a host"]), /invalid hostname/);
});

test("adds selected routes before the catch-all and preserves unrelated routes", () => {
  const result = desiredTunnelConfig(
    { ingress: [{ hostname: "panel.example.com", service: "http://panel:80" }, { service: "http_status:404" }] },
    ["example.com"],
    "http://hosting-nginx:80",
  );
  assert.deepEqual(result.ingress, [
    { hostname: "panel.example.com", service: "http://panel:80" },
    { hostname: "example.com", service: "http://hosting-nginx:80" },
    { service: "http_status:404" },
  ]);
});

test("preview is non-mutating and shows exact DNS replacement", async () => {
  const files = fixture();
  const api = new FakeApi();
  const plan = await manager(api, files).plan(["example.com"]);
  assert.equal(plan.ready, true);
  assert.equal(plan.records[0].current[0].content, "192.0.2.10");
  assert.equal(plan.records[0].desired.content, `${TUNNEL}.cfargotunnel.com`);
  assert.equal(api.updatedConfigs.length, 0);
  assert.equal(fs.existsSync(files.statePath), false);
});

test("apply refuses a standby even with confirmation", async () => {
  const files = fixture("standby");
  await assert.rejects(
    manager(new FakeApi(), files).apply(["example.com"], "SWITCH-TUNNEL-INGRESS"),
    /successfully promoted local primary/,
  );
});

test("apply records rollback state and marks ingress active", async () => {
  const files = fixture();
  const api = new FakeApi();
  const result = await manager(api, files).apply(["example.com"], "SWITCH-TUNNEL-INGRESS");
  assert.equal(result.status, "active");
  assert.equal(api.config.ingress[1].hostname, "example.com");
  assert.equal(api.records.get("example.com")[0].content, `${TUNNEL}.cfargotunnel.com`);
  assert.equal(JSON.parse(fs.readFileSync(files.statePath)).status, "active");
  assert.equal(JSON.parse(fs.readFileSync(files.promotionPath)).public_ingress_cutover, true);
  assert.equal(fs.statSync(files.statePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(files.promotionPath).mode & 0o777, 0o644);
});

test("rollback restores the prior tunnel config and DNS record", async () => {
  const files = fixture();
  const api = new FakeApi();
  const cutover = manager(api, files);
  await cutover.apply(["example.com"], "SWITCH-TUNNEL-INGRESS");
  const result = await cutover.rollback("ROLLBACK-TUNNEL-INGRESS");
  assert.equal(result.status, "rolled-back");
  assert.deepEqual(api.config.ingress, [
    { hostname: "panel.example.com", service: "http://hosting-ui:8687" },
    { service: "http_status:404" },
  ]);
  assert.equal(api.records.get("example.com")[0].type, "A");
  assert.equal(api.records.get("example.com")[0].content, "192.0.2.10");
  assert.equal(JSON.parse(fs.readFileSync(files.promotionPath)).public_ingress_cutover, false);
  assert.equal(fs.statSync(files.promotionPath).mode & 0o777, 0o644);
});

test("apply failure immediately restores tunnel and DNS state", async () => {
  const files = fixture();
  const api = new FakeApi();
  api.failNextCreate = true;
  await assert.rejects(
    manager(api, files).apply(["example.com"], "SWITCH-TUNNEL-INGRESS"),
    /simulated DNS failure/,
  );
  assert.deepEqual(api.config.ingress, [
    { hostname: "panel.example.com", service: "http://hosting-ui:8687" },
    { service: "http_status:404" },
  ]);
  assert.equal(api.records.get("example.com")[0].content, "192.0.2.10");
  assert.equal(JSON.parse(fs.readFileSync(files.statePath)).status, "rolled-back");
  assert.equal(JSON.parse(fs.readFileSync(files.promotionPath)).public_ingress_cutover, false);
});
