const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { JobManager } = require("../lib/job-manager");
const { NotificationManager } = require("../lib/notification-manager");

async function until(check, timeout = 1000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for notification state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function settings(overrides = {}) {
  return {
    resolved: () => ({
      installationName: "Test hosting",
      serverName: "test-server",
      panelUrl: "https://panel.example.com",
      telegramEnabled: true,
      telegramBotToken: "not-a-real-token",
      telegramChatIds: ["12345"],
      smtpEnabled: true,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpSecure: false,
      smtpUsername: "alerts@example.com",
      smtpPassword: "not-a-real-password",
      smtpFrom: "alerts@example.com",
      smtpRecipients: ["owner@example.com"],
      severityFailure: true,
      severityWarning: true,
      severitySuccess: false,
      ...overrides,
    }),
  };
}

test("delivers one alert per failed job and records channel results", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-notifications-manager-"));
  const telegram = [];
  const email = [];
  const jobs = new JobManager({ dataDir: directory });
  const manager = new NotificationManager({
    dataDir: directory,
    settings: settings(),
    fetch: async (url, options) => {
      telegram.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200 };
    },
    createTransport: () => ({
      sendMail: async (message) => email.push(message),
      close() {},
    }),
    retryDelaysMs: [1],
  });
  try {
    manager.start(jobs);
    jobs.register("test.failure", async () => { throw new Error("bounded test failure"); });
    jobs.start();
    const created = jobs.create({ type: "test.failure", label: "Backup example.com", targets: ["example.com"] });
    await jobs.wait(created.id);
    await until(() => manager.deliveries[0]?.status === "delivered");
    assert.equal(telegram.length, 1);
    assert.equal(email.length, 1);
    assert.match(telegram[0].body.text, /FAILURE: Backup example.com/);
    assert.doesNotMatch(telegram[0].body.text, /not-a-real-token|not-a-real-password/);
    const notification = jobs.get(created.id).notifications[0];
    assert.equal(notification.status, "delivered");
    assert.equal(notification.channels.telegram.status, "sent");
    jobs.events.emit("changed", created.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(manager.deliveries.length, 1);
  } finally {
    manager.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("retries a transient provider failure and filters successful jobs", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-notifications-retry-"));
  let attempts = 0;
  const jobs = new JobManager({ dataDir: directory });
  const manager = new NotificationManager({
    dataDir: directory,
    settings: settings({ smtpEnabled: false }),
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary outage for not-a-real-token");
      return { ok: true, status: 200 };
    },
    retryDelaysMs: [1],
  });
  try {
    manager.start(jobs);
    jobs.register("test.partial", async () => ({ ok: false, results: [{ ok: true }, { ok: false }] }));
    jobs.register("test.success", async () => ({ ok: true }));
    jobs.start();
    const failed = jobs.create({ type: "test.partial", label: "Partial operation" });
    await jobs.wait(failed.id);
    await until(() => manager.deliveries[0]?.status === "retrying");
    assert.doesNotMatch(manager.deliveries[0].channels.telegram.error, /not-a-real-token/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await manager.process();
    assert.equal(manager.deliveries[0].status, "delivered");
    assert.equal(manager.deliveries[0].channels.telegram.attempts, 2);
    const succeeded = jobs.create({ type: "test.success", label: "Successful operation" });
    await jobs.wait(succeeded.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(manager.deliveries.length, 1);
  } finally {
    manager.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("applies independent channel severity overrides", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-notifications-channel-filter-"));
  const telegram = [];
  const email = [];
  const jobs = new JobManager({ dataDir: directory });
  const manager = new NotificationManager({
    dataDir: directory,
    settings: settings({
      telegramUseGlobalSeverity: false,
      telegramSeverityWarning: false,
      smtpUseGlobalSeverity: false,
      smtpSeverityWarning: true,
    }),
    fetch: async (...args) => { telegram.push(args); return { ok: true, status: 200 }; },
    createTransport: () => ({ sendMail: async (message) => email.push(message), close() {} }),
  });
  try {
    manager.start(jobs);
    jobs.register("test.warning", async () => ({ ok: false, results: [{ ok: true }, { ok: false }] }));
    jobs.start();
    const created = jobs.create({ type: "test.warning", label: "Partial operation" });
    await jobs.wait(created.id);
    await until(() => manager.deliveries[0]?.status === "delivered");
    assert.deepEqual(Object.keys(manager.deliveries[0].channels), ["smtp"]);
    assert.equal(telegram.length, 0);
    assert.equal(email.length, 1);
  } finally {
    manager.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("delivers and deduplicates generic health events despite job success filtering", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-notifications-health-"));
  const messages = [];
  const manager = new NotificationManager({
    dataDir: directory,
    settings: settings({ smtpEnabled: false, severitySuccess: false }),
    fetch: async (_url, options) => {
      messages.push(JSON.parse(options.body).text);
      return { ok: true, status: 200 };
    },
  });
  try {
    const event = {
      eventType: "health",
      eventId: "event-1",
      dedupeKey: "health:event-1",
      severity: "success",
      label: "Recovered: hosting-db",
      status: "resolved",
      targets: ["hosting-db"],
      message: "Database is available again.",
      respectSeverityFilter: false,
    };
    const first = manager.enqueueEvent(event);
    const duplicate = manager.enqueueEvent(event);
    assert.equal(first.id, duplicate.id);
    await until(() => manager.deliveries[0]?.status === "delivered");
    assert.equal(messages.length, 1);
    assert.match(messages[0], /SUCCESS: Recovered: hosting-db/);
  } finally {
    manager.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
