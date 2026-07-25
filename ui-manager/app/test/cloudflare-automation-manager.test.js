const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { JobManager } = require("../lib/job-manager");
const {
  CloudflareAutomationManager,
  reservedBlockList,
} = require("../lib/cloudflare-automation-manager");

function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cloudflare-automation-"));
}

function fakeClient() {
  const calls = [];
  const settings = new Map([
    ["security_level", "low"],
    ["browser_check", "off"],
    ["challenge_ttl", 900],
    ["cache_level", "basic"],
    ["browser_cache_ttl", 14400],
    ["always_online", "off"],
  ]);
  return {
    calls,
    settings,
    securityPreset(domain, preset) {
      return {
        phase: preset === "login-rate-limit" ? "http_ratelimit" : "http_request_firewall_custom",
        rule: {
          action: preset === "login-rate-limit" ? "block" : "managed_challenge",
          description: `[Hosting Control] ${preset} ${domain}`,
          enabled: true,
          expression: `http.host eq "${domain}"`,
          ref: `hosting-control-${preset}-${domain}`,
        },
      };
    },
    async previewPanelRule(domain, definition) {
      calls.push(["preview-rule", domain, definition.rule.ref]);
      return {
        zone: { id: "zone-1", name: "example.test" },
        rulesetId: "ruleset-1",
        existing: null,
        desired: definition.rule,
        change: "create",
      };
    },
    async zoneSetting(domain, setting) {
      calls.push(["get-setting", domain, setting]);
      return {
        zone: { id: "zone-1", name: "example.test" },
        id: setting,
        value: settings.get(setting),
        editable: true,
      };
    },
    async applySecurityPreset(domain, preset) {
      calls.push(["apply-rule", domain, preset]);
      return {
        created: true,
        updated: false,
        rulesetId: "ruleset-1",
        rule: { id: `rule-${preset}` },
      };
    },
    async setZoneSetting(domain, setting, value) {
      calls.push(["set-setting", domain, setting, value]);
      settings.set(setting, value);
      return {};
    },
    async deleteSecurityRule(domain, rulesetId, ruleId) {
      calls.push(["delete-rule", domain, rulesetId, ruleId]);
    },
    async restorePanelRule(domain, rulesetId, ruleId, previous) {
      calls.push(["restore-rule", domain, rulesetId, ruleId, previous]);
    },
    async zoneForDomain() {
      return { id: "zone-1", name: "example.test" };
    },
    async purgeZoneCache(domain) {
      calls.push(["purge", domain]);
    },
    async applyPanelRule(domain, definition) {
      calls.push(["apply-panel-rule", domain, definition.rule.action]);
      return { created: true, rulesetId: "ruleset-1", rule: { id: "mitigation-rule" } };
    },
  };
}

function managerFixture(options = {}) {
  const dataDir = temporary();
  const client = fakeClient();
  const jobManager = new JobManager({ dataDir: path.join(dataDir, "jobs") });
  const sites = options.sites || [{
    host: "www.example.test",
    isAlias: false,
    isWwwAlias: false,
    state: { siteType: "wordpress" },
  }];
  const manager = new CloudflareAutomationManager({
    dataDir,
    client,
    jobManager,
    siteProvider: async () => sites,
    serverAddresses: () => options.serverAddresses || [],
    proxyRangesProvider: async () => options.proxyRanges || ["173.245.48.0/20", "2400:cb00::/32"],
  });
  return { client, dataDir, jobManager, manager };
}

function context() {
  return { update: () => {}, checkpoint: () => {} };
}

test("stores provisioning defaults and preserves per-site opt-out", () => {
  const { manager } = managerFixture();
  manager.updateSettings({
    provisioningDefaultsEnabled: true,
    provisioningPresets: ["sensitive-files", "wordpress-login"],
    protectedAddresses: ["8.8.4.4"],
  });
  assert.deepEqual(
    manager.provisioningSelection("wordpress", true),
    ["sensitive-files", "wordpress-login"],
  );
  assert.deepEqual(manager.provisioningSelection("static", true), ["sensitive-files"]);
  assert.deepEqual(manager.provisioningSelection("wordpress", false), []);
  assert.throws(() => manager.updateSettings({ protectedAddresses: ["not-an-ip"] }), /invalid/);
});

test("dry run is immutable and deduplicates zone settings shared by websites", async () => {
  const { client, manager } = managerFixture({
    sites: [
      { host: "one.example.test", state: { siteType: "wordpress" } },
      { host: "two.example.test", state: { siteType: "wordpress" } },
    ],
  });
  const preview = await manager.previewBulk(
    ["one.example.test", "two.example.test"],
    ["security-baseline"],
  );
  assert.equal(preview.operations.length, 3);
  assert.equal(preview.totals.changes, 3);
  assert.equal(client.calls.some((call) => call[0] === "set-setting"), false);
  assert.match(preview.id, /^[a-f0-9]{64}$/);
});

test("bulk apply records previous settings and rollback reverses only recorded changes", async () => {
  const { client, manager } = managerFixture();
  const preview = await manager.previewBulk(
    ["www.example.test"],
    ["sensitive-files", "security-baseline"],
  );
  const result = await manager.applyBulk({
    domains: preview.domains,
    presets: preview.presets,
    previewId: preview.id,
    operator: "operator@example.test",
  }, context());
  assert.equal(result.ok, true);
  const batch = manager.history()[0];
  assert.equal(batch.operator, "operator@example.test");
  assert.equal(batch.rollback.length, 4);
  const rollback = await manager.rollbackBulk(batch.id, context());
  assert.equal(rollback.ok, true);
  assert.equal(client.calls.some((call) => call[0] === "delete-rule"), true);
  assert.equal(client.settings.get("security_level"), "low");
});

test("rejects protected, reserved, server, and Cloudflare proxy addresses", async () => {
  const { manager } = managerFixture({ serverAddresses: ["8.8.8.8"] });
  manager.updateSettings({ protectedAddresses: ["9.9.9.9"] });
  await assert.rejects(() => manager.validateIncidentAddress("192.168.1.10"), /Private|reserved/);
  await assert.rejects(() => manager.validateIncidentAddress("8.8.8.8"), /hosting server/);
  await assert.rejects(() => manager.validateIncidentAddress("9.9.9.9"), /protected/);
  await assert.rejects(() => manager.validateIncidentAddress("173.245.48.10"), /proxy/);
  assert.equal(reservedBlockList().check("2001:db8::1", "ipv6"), true);
});

test("applies an exact-host temporary mitigation idempotently and removes it", async () => {
  const { client, manager } = managerFixture();
  const preview = await manager.previewIncident({
    domain: "www.example.test",
    address: "8.8.8.8",
    action: "managed_challenge",
    duration: 600,
    sourceStatsAt: "2026-07-25T10:00:00Z",
  });
  const first = await manager.applyIncident({ preview, operator: "operator@example.test" }, context());
  assert.equal(first.ok, true);
  const secondPreview = await manager.previewIncident({
    domain: "www.example.test",
    address: "8.8.8.8",
    action: "block",
    duration: 3600,
    sourceStatsAt: "2026-07-25T10:00:00Z",
  });
  await manager.applyIncident({ preview: secondPreview, operator: "operator@example.test" }, context());
  assert.equal(manager.incidents().length, 1);
  assert.match(manager.incidents()[0].expression, /http\.host eq "www\.example\.test"/);
  assert.match(manager.incidents()[0].expression, /ip\.src eq 8\.8\.8\.8/);
  const result = await manager.removeIncident(manager.incidents()[0].id, context());
  assert.equal(result.ok, true);
  assert.equal(client.calls.some((call) => call[0] === "delete-rule"), true);
});
