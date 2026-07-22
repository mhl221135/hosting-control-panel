const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { NotificationSettings } = require("../lib/notification-settings");

test("encrypts notification credentials and exposes only configuration state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-notifications-settings-"));
  try {
    const settings = new NotificationSettings(directory);
    const view = settings.update({
      installationName: "Production hosting",
      serverName: "opi5",
      panelUrl: "https://panel.example.com/",
      telegramEnabled: true,
      telegramBotToken: "telegram-secret",
      telegramChatIds: "12345\n-67890\n12345",
      smtpEnabled: true,
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecure: true,
      smtpUsername: "alerts@example.com",
      smtpPassword: "smtp-secret",
      smtpFrom: "alerts@example.com",
      smtpRecipients: "owner@example.com, admin@example.com",
      severityFailure: true,
      severityWarning: true,
      severitySuccess: false,
    });
    assert.equal(view.panelUrl, "https://panel.example.com");
    assert.equal(view.serverName, "opi5");
    assert.equal(view.telegramBotTokenConfigured, true);
    assert.equal(view.smtpPasswordConfigured, true);
    assert.equal(view.telegramChatIds, "12345\n-67890");
    assert.equal(settings.resolved().telegramBotToken, "telegram-secret");
    assert.equal(settings.resolved().smtpPassword, "smtp-secret");
    const stored = fs.readFileSync(settings.settingsPath, "utf8");
    assert.doesNotMatch(stored, /telegram-secret|smtp-secret/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("validates enabled channels and public URLs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-notifications-validation-"));
  try {
    const settings = new NotificationSettings(directory);
    assert.throws(() => settings.update({ telegramEnabled: true }), /bot token and at least one chat ID/);
    assert.throws(() => settings.update({ panelUrl: "javascript:alert(1)" }), /must start with http/);
    assert.throws(() => settings.update({
      smtpEnabled: true,
      smtpHost: "smtp.example.com",
      smtpFrom: "invalid",
      smtpRecipients: "owner@example.com",
    }), /valid SMTP/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
