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
