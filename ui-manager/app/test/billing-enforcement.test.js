const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  BillingEnforcementManager,
  buildPlan,
  ensureNginxIntegration,
  normalizeSettings,
  renderMap,
} = require("../lib/billing-enforcement");

const RENEWAL_URL = "https://billing.example.com/renew/opaque_reference";

function observerView(overrides = {}) {
  return {
    snapshot: {
      fresh: true,
      generatedAt: "2026-07-29T09:59:30Z",
      matches: [{
        serviceId: "svc_1234567890abcdef12345678",
        primaryDomain: "example.com",
        aliases: ["www.example.com"],
        localDomain: "example.com",
        state: "suspended",
        enforcementMode: "payment_page",
        renewalUrl: RENEWAL_URL,
      }],
      ...overrides,
    },
  };
}

function sites() {
  return [{
    host: "example.com",
    aliases: ["www.example.com", "unowned.example.com"],
    isAlias: false,
  }];
}

test("requires every blocking gate and includes only signed local aliases", () => {
  const disabled = buildPlan(observerView(), sites(), { enabled: false, pilotDomains: ["example.com"] });
  assert.deepEqual(disabled.blockedHosts, []);
  const allowed = buildPlan(observerView(), sites(), { enabled: true, pilotDomains: ["example.com"] });
  assert.deepEqual(allowed.blockedHosts, ["example.com", "www.example.com"]);
  assert.equal(allowed.entries["unowned.example.com"], undefined);
  assert.equal(allowed.rows[0].action, "block");
  const stale = buildPlan(observerView({ fresh: false }), sites(), {
    enabled: true,
    pilotDomains: ["example.com"],
  });
  assert.deepEqual(stale.blockedHosts, []);
  assert.match(stale.rows[0].reason, /stale/);
  const active = buildPlan(observerView({
    matches: [{ ...observerView().snapshot.matches[0], state: "active" }],
  }), sites(), { enabled: true, pilotDomains: ["example.com"] });
  assert.deepEqual(active.blockedHosts, []);
});

test("renders a bounded map and idempotent nginx integration", () => {
  assert.match(renderMap({ "example.com": RENEWAL_URL }), /example\.com "https:\/\/billing\.example\.com/);
  assert.throws(() => renderMap({ "invalid host": RENEWAL_URL }), /invalid/);
  assert.throws(
    () => renderMap({ "example.com": "http://billing.example.com/renew/reference" }),
    /invalid/,
  );
  const source = [
    "include /etc/nginx/conf.d/sites.map;",
    "include /etc/nginx/conf.d/cache.map;",
    "",
    "server {",
    "    # Managed sensitive-file protection.",
    "}",
    "",
  ].join("\n");
  const migrated = ensureNginxIntegration(source);
  assert.match(migrated, /billing-enforcement\.map/);
  assert.match(migrated, /return 302 \$billing_renewal_url/);
  assert.equal(ensureNginxIntegration(migrated), migrated);
  assert.deepEqual(normalizeSettings({ enabled: true, pilotDomains: "example.com\nexample.com" }), {
    enabled: true,
    pilotDomains: ["example.com"],
  });
});

test("applies atomically, restores on validation failure, and disables immediately", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "billing-enforcement-"));
  const mapPath = path.join(root, "billing-enforcement.map");
  const defaultPath = path.join(root, "default.conf");
  fs.writeFileSync(defaultPath, [
    "include /etc/nginx/conf.d/cache.map;",
    "server {",
    "    # Managed sensitive-file protection.",
    "}",
    "",
  ].join("\n"));
  let fail = false;
  let reloads = 0;
  const notifications = [];
  const observer = { view: async () => observerView() };
  const manager = new BillingEnforcementManager({
    dataDir: root,
    mapPath,
    nginxDefaultPath: defaultPath,
    observer,
    siteProvider: async () => sites(),
    validateReload: async () => {
      reloads += 1;
      if (fail) throw new Error("nginx rejected candidate");
    },
    notificationManager: {
      enqueueEvent(event) {
        notifications.push(event);
        return { id: "delivery" };
      },
    },
    now: () => Date.parse("2026-07-29T10:00:00Z"),
  });
  try {
    assert.equal(manager.prepare(), true);
    manager.saveSettings({ enabled: true, pilotDomains: ["example.com"] });
    const applied = await manager.reconcile("operator@example.com");
    assert.deepEqual(applied.blockedHosts, ["example.com", "www.example.com"]);
    assert.equal(manager.readHistory()[0].result, "applied");
    assert.equal(manager.readHistory()[0].transition, "block");
    assert.equal(manager.readHistory()[0].snapshotGeneratedAt, "2026-07-29T09:59:30Z");
    assert.equal(JSON.stringify(manager.readHistory()).includes(RENEWAL_URL), false);
    const beforeFailure = fs.readFileSync(mapPath, "utf8");
    fail = true;
    observer.view = async () => observerView({
      matches: [{
        ...observerView().snapshot.matches[0],
        state: "active",
      }],
    });
    await assert.rejects(manager.reconcile("operator@example.com"), /rollback validation also failed/);
    assert.equal(fs.readFileSync(mapPath, "utf8"), beforeFailure);
    assert.deepEqual(manager.readStatus().blockedHosts, ["example.com", "www.example.com"]);
    assert.equal(manager.readHistory()[0].result, "failed");
    assert.equal(manager.readHistory()[0].transition, "restore");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].severity, "critical");
    assert.equal(notifications[0].respectSeverityFilter, false);
    assert.deepEqual(notifications[0].targets, ["example.com"]);
    fail = false;
    const disabled = await manager.disableAll("operator@example.com");
    assert.deepEqual(disabled.blockedHosts, []);
    assert.deepEqual(manager.readSettings(), { enabled: false, pilotDomains: ["example.com"] });
    assert.equal(fs.readFileSync(mapPath, "utf8"), renderMap());
    assert.equal(manager.readHistory()[0].result, "applied");
    assert.equal(manager.readHistory()[0].transition, "restore");
    assert.ok(reloads >= 3);
  } finally {
    manager.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requires scheduled signed observation before enforcement can be enabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "billing-enforcement-schedule-"));
  const manager = new BillingEnforcementManager({
    dataDir: root,
    mapPath: path.join(root, "billing-enforcement.map"),
    nginxDefaultPath: path.join(root, "default.conf"),
    observer: {
      readSettings: () => ({ enabled: false }),
      view: async () => observerView(),
    },
    siteProvider: async () => sites(),
  });
  try {
    await assert.rejects(
      manager.updateSettings({ enabled: true, pilotDomains: ["example.com"] }, "operator@example.com"),
      /scheduled billing entitlement observation/,
    );
    assert.deepEqual(manager.readSettings(), { enabled: false, pilotDomains: [] });
  } finally {
    manager.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
