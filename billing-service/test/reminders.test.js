const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { importCsv } = require("../app/lib/csv");
const { BillingDatabase } = require("../app/lib/database");
const { NotificationClient, ReminderManager, localClock } = require("../app/lib/reminders");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-billing-reminders-"));
  const database = new BillingDatabase(root);
  const input = importCsv([
    "Order #,Website,Hosting Next Payment,Grace Days,Price Hosting",
    "51,reminder.example.com,2026-08-01,7,120.00",
    "52,grace.example.com,2026-07-25,7,120.00",
    "53,suspended.example.com,2026-07-01,7,120.00",
    "54,active.example.com,2027-07-01,7,120.00",
  ].join("\n"));
  database.importServices(input.services, input.fingerprint, "admin@example.com");
  return { root, database };
}

test("previews due states and delivers each reminder key once", async () => {
  const value = fixture();
  const sent = [];
  let failGrace = true;
  const manager = new ReminderManager(value.database, {
    async send(reminder) {
      sent.push(reminder);
      if (reminder.domain === "grace.example.com" && failGrace) throw new Error("temporary notification outage");
      return { id: `delivery-${sent.length}` };
    },
  });
  const now = new Date("2026-07-28T12:00:00Z");
  try {
    const preview = manager.preview(now);
    assert.deepEqual(preview.map((item) => item.state).sort(), ["grace", "reminder", "suspended"]);
    assert.equal(preview.find((item) => item.state === "reminder").days_remaining, 4);
    assert.equal(preview.find((item) => item.state === "grace").days_remaining, -3);

    const first = await manager.run("admin@example.com", now);
    assert.equal(first.results.filter((item) => item.ok).length, 2);
    assert.equal(first.results.filter((item) => !item.ok).length, 1);
    assert.equal(value.database.reminderHistory().filter((item) => item.status === "sent").length, 2);

    failGrace = false;
    const second = await manager.run("admin@example.com", now);
    assert.equal(second.attempted, 1);
    assert.equal(second.results[0].domain, "grace.example.com");
    assert.equal(value.database.reminderHistory().every((item) => item.status === "sent"), true);

    const third = await manager.run("admin@example.com", now);
    assert.equal(third.attempted, 0);
    assert.equal(sent.length, 4);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("keeps scheduled reminders disabled by default and runs once per local date", async () => {
  const value = fixture();
  let deliveries = 0;
  const manager = new ReminderManager(value.database, {
    async send() {
      deliveries += 1;
      return { id: `delivery-${deliveries}` };
    },
  }, { timezone: "Europe/Kyiv" });
  const now = new Date("2026-07-28T08:30:00Z");
  try {
    assert.equal(await manager.tick(now), null);
    value.database.updateReminderSettings({ enabled: true, time: "10:00" }, "admin@example.com");
    assert.equal(localClock(now, "Europe/Kyiv").time, "11:30");
    const first = await manager.tick(now);
    assert.equal(first.results.length, 3);
    assert.equal(value.database.reminderSettings().lastRun, "2026-07-28");
    assert.equal(await manager.tick(new Date("2026-07-28T18:00:00Z")), null);
  } finally {
    value.database.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("sends only the bearer-authenticated bounded reminder contract", async () => {
  let captured;
  const client = new NotificationClient({
    url: "http://hosting-ui.test/internal/v1/billing-reminders",
    token: "x".repeat(64),
    fetch: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 202, json: async () => ({ delivery: { id: "delivery-1" } }) };
    },
  });
  const delivery = await client.send({
    reminder_key: "a".repeat(64),
    service_id: "svc_1234567890",
    domain: "example.com",
    state: "reminder",
    paid_through: "2026-08-01",
    days_remaining: 4,
  });
  assert.equal(delivery.id, "delivery-1");
  assert.equal(captured.options.headers.Authorization, `Bearer ${"x".repeat(64)}`);
  assert.equal(JSON.parse(captured.options.body).domain, "example.com");
});
