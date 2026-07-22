const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { HealthMonitor } = require("../lib/health-monitor");

function configured() {
  return {
    enabled: true,
    intervalMinutes: 5,
    diskWarningPercent: 98,
    diskCriticalPercent: 99,
    certificateWarningDays: 30,
    certificateCriticalDays: 7,
    opcacheWarningPercent: 95,
    requiredContainers: ["hosting-ui"],
  };
}

test("notifies only on health transitions and records recovery", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-health-monitor-"));
  let current = new Date("2026-07-22T10:00:00.000Z");
  let containerRunning = false;
  const notifications = [];
  const notificationManager = {
    enqueueEvent(event) {
      notifications.push(event);
      return { id: `delivery-${notifications.length}` };
    },
    publicDelivery(id) { return { id, status: "delivered", channels: { telegram: { status: "sent" } } }; },
  };
  const exec = async (_file, args) => {
    if (args[0] === "inspect") return JSON.stringify({ Running: containerRunning, Status: containerRunning ? "running" : "exited" });
    if (args[0] === "exec") return "mysqld is alive\n";
    throw new Error("unexpected command");
  };
  const monitor = new HealthMonitor({
    dataDir: directory,
    websitesRoot: directory,
    backupsRoot: directory,
    settings: { read: configured },
    notificationManager,
    statsCollector: { runtime: async () => ({ opcache: { enabled: true, cacheFull: false, memory: { usedBytes: 50, freeBytes: 50 } } }) },
    npm: { listHosts: async () => [], listCertificates: async () => [] },
    exec,
    now: () => current,
  });
  try {
    let result = await monitor.run();
    assert.equal(result.summary.critical, 1);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].status, "opened");
    assert.equal(notifications[0].respectSeverityFilter, false);

    current = new Date("2026-07-22T10:05:00.000Z");
    result = await monitor.run();
    assert.equal(result.summary.critical, 1);
    assert.equal(notifications.length, 1);

    containerRunning = true;
    current = new Date("2026-07-22T10:10:00.000Z");
    result = await monitor.run();
    assert.equal(result.summary.healthy, true);
    assert.equal(notifications.length, 2);
    assert.equal(notifications[1].status, "resolved");
    assert.equal(notifications[1].severity, "success");
    assert.equal(result.history[0].delivery.status, "delivered");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("checks only certificates attached to enabled proxy hosts", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-health-certificates-"));
  const notifications = [];
  const monitor = new HealthMonitor({
    dataDir: directory,
    websitesRoot: directory,
    backupsRoot: directory,
    settings: { read: configured },
    notificationManager: {
      enqueueEvent(event) { notifications.push(event); return { id: "delivery" }; },
      publicDelivery() { return null; },
    },
    statsCollector: { runtime: async () => ({ opcache: { enabled: true, memory: { usedBytes: 1, freeBytes: 99 } } }) },
    npm: {
      listHosts: async () => [{ enabled: true, certificate_id: 4 }, { enabled: false, certificate_id: 5 }],
      listCertificates: async () => [
        { id: 4, expires_on: "2026-07-25T00:00:00.000Z", domain_names: ["example.com"] },
        { id: 5, expires_on: "2026-07-23T00:00:00.000Z", domain_names: ["disabled.example.com"] },
      ],
    },
    exec: async (_file, args) => args[0] === "inspect" ? JSON.stringify({ Running: true, Status: "running" }) : "alive\n",
    now: () => new Date("2026-07-22T00:00:00.000Z"),
  });
  try {
    const result = await monitor.run();
    assert.equal(result.active.filter((item) => item.type === "certificate").length, 1);
    assert.equal(result.active.find((item) => item.type === "certificate").target, "example.com");
    assert.equal(notifications.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
