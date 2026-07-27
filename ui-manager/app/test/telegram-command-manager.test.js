const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { commandFrom, TelegramCommandManager } = require("../lib/telegram-command-manager");

function settings(overrides = {}) {
  return {
    resolved: () => ({
      installationName: "Test hosting",
      serverName: "test-server",
      panelUrl: "https://panel.example.com",
      telegramEnabled: true,
      telegramCommandsEnabled: true,
      telegramBotToken: "secret",
      telegramChatIds: ["123"],
      telegramCommandUserIds: ["456"],
      ...overrides,
    }),
  };
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test("parses only bounded slash commands", () => {
  assert.deepEqual(commandFrom("/site Example.COM"), { name: "site", argument: "example.com" });
  assert.deepEqual(commandFrom("/status@hosting_bot"), { name: "status", argument: "" });
  assert.equal(commandFrom("status"), null);
});

test("polls allowlisted read-only commands and persists the update cursor", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-telegram-commands-"));
  const sent = [];
  let polls = 0;
  const manager = new TelegramCommandManager({
    dataDir: directory,
    settings: settings(),
    healthProvider: () => ({
      lastCheckAt: "2026-07-27T10:00:00.000Z",
      summary: { healthy: false, critical: 1, warning: 2 },
    }),
    siteProvider: () => [{
      host: "example.com",
      poolTier: "medium",
      isAlias: false,
      state: { siteType: "wordpress", opcache: true, redis: true, fastcgiCache: false, backupEnabled: true },
    }],
    jobProvider: () => [{ status: "running" }, { status: "failed", finishedAt: new Date().toISOString() }],
    fetch: async (url, options = {}) => {
      if (String(url).includes("getUpdates")) {
        polls += 1;
        return response({ ok: true, result: [
          { update_id: 10, message: { text: "/status", chat: { id: 123 }, from: { id: 456 } } },
          { update_id: 11, message: { text: "/site example.com", chat: { id: 123 }, from: { id: 456 } } },
          { update_id: 12, message: { text: "/status", chat: { id: 999 }, from: { id: 456 } } },
        ] });
      }
      sent.push(JSON.parse(options.body));
      return response({ ok: true, result: {} });
    },
  });
  try {
    await manager.poll();
    assert.equal(polls, 1);
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /Health: 1 critical, 2 warning/);
    assert.match(sent[0].text, /Active jobs: 1/);
    assert.match(sent[1].text, /Pool: medium/);
    assert.match(sent[1].text, /Redis: enabled/);
    assert.equal(manager.state.offset, 13);
    assert.equal(manager.state.history[0].result, "denied");
    const stored = fs.readFileSync(manager.path, "utf8");
    assert.doesNotMatch(stored, /secret/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("does not poll unless commands and both allowlists are configured", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-telegram-disabled-"));
  let calls = 0;
  const manager = new TelegramCommandManager({
    dataDir: directory,
    settings: settings({ telegramCommandUserIds: [] }),
    healthProvider: () => ({}),
    siteProvider: () => [],
    jobProvider: () => [],
    fetch: async () => { calls += 1; return response({ ok: true, result: [] }); },
  });
  try {
    await manager.poll();
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("requires one-use confirmation before backup or purge mutations", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-telegram-mutations-"));
  const sent = [];
  const backups = [];
  const purges = [];
  let now = new Date("2026-07-27T12:00:00.000Z");
  const manager = new TelegramCommandManager({
    dataDir: directory,
    settings: settings({ telegramMutationsEnabled: true }),
    healthProvider: () => ({}),
    siteProvider: () => [{ host: "example.com", isAlias: false, state: { siteType: "wordpress" } }],
    jobProvider: () => [],
    backupProvider: async (domain, operator) => {
      backups.push({ domain, operator });
      return { message: `Backup queued for ${domain}.\nJob: job-1` };
    },
    purgeProvider: async (domain, operator) => {
      purges.push({ domain, operator });
      return { message: `Cache purged for ${domain}.` };
    },
    fetch: async (_url, options) => {
      sent.push(JSON.parse(options.body).text);
      return response({ ok: true, result: {} });
    },
    now: () => now,
    challengeCode: () => "abc123",
    confirmationTtlMs: 120_000,
  });
  const update = (id, text) => ({
    update_id: id,
    message: { text, chat: { id: 123 }, from: { id: 456 } },
  });
  try {
    await manager.handle(update(1, "/backup example.com"), settings({ telegramMutationsEnabled: true }).resolved());
    assert.equal(backups.length, 0);
    assert.match(sent.at(-1), /\/confirm abc123/);
    await manager.handle(update(2, "/confirm wrong"), settings({ telegramMutationsEnabled: true }).resolved());
    assert.equal(backups.length, 0);
    assert.match(sent.at(-1), /does not match/);
    await manager.handle(update(3, "/confirm abc123"), settings({ telegramMutationsEnabled: true }).resolved());
    assert.deepEqual(backups, [{ domain: "example.com", operator: "telegram:456" }]);
    assert.match(sent.at(-1), /Job: job-1/);
    await manager.handle(update(3, "/confirm abc123"), settings({ telegramMutationsEnabled: true }).resolved());
    assert.equal(backups.length, 1);

    await manager.handle(update(4, "/purge example.com"), settings({ telegramMutationsEnabled: true }).resolved());
    now = new Date(now.getTime() + 120_001);
    await manager.handle(update(5, "/confirm abc123"), settings({ telegramMutationsEnabled: true }).resolved());
    assert.equal(purges.length, 0);
    assert.match(sent.at(-1), /expired/);
    await manager.handle(update(6, "/purge example.com"), settings({ telegramMutationsEnabled: true }).resolved());
    await manager.handle(update(7, "/confirm abc123"), settings({ telegramMutationsEnabled: true }).resolved());
    assert.deepEqual(purges, [{ domain: "example.com", operator: "telegram:456" }]);
    await manager.handle(update(8, "/backup example.com"), settings({ telegramMutationsEnabled: true }).resolved());
    await manager.handle(update(9, "/cancel"), settings({ telegramMutationsEnabled: true }).resolved());
    assert.equal(backups.length, 1);
    assert.match(sent.at(-1), /Cancelled backup/);
    assert.equal(manager.state.history.find((item) => item.updateId === 3).result, "executed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps mutation commands disabled independently from read-only commands", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-telegram-readonly-"));
  const sent = [];
  const manager = new TelegramCommandManager({
    dataDir: directory,
    settings: settings({ telegramMutationsEnabled: false }),
    healthProvider: () => ({}),
    siteProvider: () => [{ host: "example.com", isAlias: false }],
    jobProvider: () => [],
    backupProvider: async () => { throw new Error("must not run"); },
    purgeProvider: async () => { throw new Error("must not run"); },
    fetch: async (_url, options) => {
      sent.push(JSON.parse(options.body).text);
      return response({ ok: true, result: {} });
    },
  });
  try {
    await manager.handle({
      update_id: 1,
      message: { text: "/backup example.com", chat: { id: 123 }, from: { id: 456 } },
    }, settings({ telegramMutationsEnabled: false }).resolved());
    assert.match(sent[0], /disabled in panel settings/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
