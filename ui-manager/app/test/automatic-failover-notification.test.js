const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { AutomaticFailoverNotificationMonitor } = require("../lib/automatic-failover-status");

function writeStatus(directory, status, checkedAt = "2026-08-22T08:00:00Z") {
  fs.writeFileSync(path.join(directory, "automatic-failover-state.json"), JSON.stringify({
    version: 1,
    status,
    checkedAt,
    failures: status === "healthy" ? 0 : 6,
    threshold: 6,
    fencePolicy: "unreachable",
    recoveryId: "2026-08-22T07-27-46Z",
  }));
}

test("notifies only on meaningful automatic failover transitions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "failover-notification-"));
  const events = [];
  const monitor = new AutomaticFailoverNotificationMonitor({
    dataDir: directory,
    notificationManager: { enqueueEvent: (event) => { events.push(event); return event; } },
  });

  writeStatus(directory, "healthy");
  assert.equal(monitor.tick(), null);
  assert.equal(events.length, 0);

  writeStatus(directory, "primary-unreachable", "2026-08-22T08:01:00Z");
  monitor.tick();
  monitor.tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].severity, "warning");
  assert.equal(events[0].respectSeverityFilter, false);

  writeStatus(directory, "promoted-unreachable", "2026-08-22T08:06:00Z");
  monitor.tick();
  assert.equal(events.length, 2);
  assert.equal(events[1].severity, "failure");

  writeStatus(directory, "healthy", "2026-08-22T08:07:00Z");
  monitor.tick();
  assert.equal(events.length, 3);
  assert.equal(events[2].severity, "success");
});

test("reports an invalid qualified-host state instead of treating it as unavailable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "failover-notification-blocked-"));
  const events = [];
  writeStatus(directory, "blocked-host-qualification");
  const monitor = new AutomaticFailoverNotificationMonitor({
    dataDir: directory,
    notificationManager: { enqueueEvent: (event) => { events.push(event); return event; } },
  });
  monitor.tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "blocked-host-qualification");
});
