const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { atomicWriteFile, atomicWriteJson } = require("../lib/safe-write");
const { guardSettingsBody, rejectControlChars, rejectObjectControlChars } = require("../lib/runtime-validation");
const { IntegrationSettings } = require("../lib/integration-settings");
const { NotificationSettings } = require("../lib/notification-settings");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("atomicWriteJson persists atomically with 0600 mode and cleans temp on failure", () => {
  const dir = tmpDir("sw-");
  try {
    const file = path.join(dir, "settings.json");
    atomicWriteJson(file, { a: 1 });
    assert.equal(fs.existsSync(file), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1 });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
    // Failure path (rename onto a directory) leaves no temp behind and throws.
    const blocker = path.join(dir, "blocker");
    fs.mkdirSync(blocker);
    assert.throws(() => atomicWriteFile(blocker, "x"));
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("guardSettingsBody rejects unknown fields, pollution keys, and control characters", () => {
  const allowed = new Set(["name", "retention"]);
  assert.deepEqual(guardSettingsBody({ name: "x", retention: 7 }, { allowed, label: "test" }), { name: "x", retention: 7 });
  assert.throws(() => guardSettingsBody({ name: "x", bogus: 1 }, { allowed, label: "test" }), /Unsupported field 'bogus' in test/);
  assert.throws(() => guardSettingsBody(JSON.parse('{"__proto__":{"x":1}}'), { allowed, label: "test" }), /Unsupported request key/);
  assert.throws(() => guardSettingsBody("nope", { allowed, label: "test" }), /JSON object/);
  assert.throws(() => guardSettingsBody({ name: "a\nb" }, { allowed, stringKeys: ["name"], label: "test" }), /control characters/);
  assert.throws(() => guardSettingsBody({ name: "a\u0000" }, { allowed, stringKeys: ["name"], label: "test" }), /control characters/);
});

test("rejectControlChars rejects CR/LF/NUL and allows normal text", () => {
  assert.equal(rejectControlChars("hello"), "hello");
  assert.throws(() => rejectControlChars("a\rb"), /control characters/);
  assert.throws(() => rejectControlChars("a\nb"), /control characters/);
  assert.throws(() => rejectControlChars("a\x00b"), /control characters/);
});

test("rejectObjectControlChars checks only listed keys", () => {
  const obj = { endpoint: "https://ok.example", bucket: "garbage\ngarbage" };
  assert.equal(rejectObjectControlChars(obj, { stringKeys: ["endpoint"] }).bucket, "garbage\ngarbage");
  assert.throws(() => rejectObjectControlChars(obj, { stringKeys: ["bucket"] }), /control characters/);
});

test("integration settings preserve masked and omitted secrets atomically", () => {
  const dir = tmpDir("is-");
  try {
    const settings = new IntegrationSettings(dir);
    settings.update({ npmApiUrl: "http://npm:81/api", npmSecret: "s3cret", cloudflareToken: "tok_abc" });
    // Omitted secret fields preserve current encrypted values.
    settings.update({ npmApiUrl: "http://npm:81/api" });
    let stored = JSON.parse(fs.readFileSync(settings.settingsPath, "utf8"));
    assert.equal(settings.decrypt(stored.npmSecret), "s3cret");
    assert.equal(settings.decrypt(stored.cloudflareToken), "tok_abc");
    // Masked empty secret also preserves.
    settings.update({ npmApiUrl: "http://npm:81/api", npmSecret: "" });
    stored = JSON.parse(fs.readFileSync(settings.settingsPath, "utf8"));
    assert.equal(settings.decrypt(stored.npmSecret), "s3cret");
    // Explicit clear removes the secret.
    settings.update({ npmApiUrl: "http://npm:81/api", clearNpmSecret: true });
    stored = JSON.parse(fs.readFileSync(settings.settingsPath, "utf8"));
    assert.equal(stored.npmSecret, "");
    assert.equal(fs.statSync(settings.settingsPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("notification settings preserve masked secrets and reject invalid inputs", () => {
  const dir = tmpDir("ns-");
  try {
    const settings = new NotificationSettings(dir);
    settings.update({ telegramEnabled: true, telegramBotToken: "botTok", telegramChatIds: "12345" });
    // Omitted token preserves.
    settings.update({ telegramEnabled: true, telegramChatIds: "12345" });
    let stored = JSON.parse(fs.readFileSync(settings.settingsPath, "utf8"));
    assert.equal(settings.decrypt(stored.telegramBotToken), "botTok");
    // Non-numeric chat id rejected while telegram is enabled.
    assert.throws(() => settings.update({ telegramEnabled: true, telegramBotToken: "botTok", telegramChatIds: "abc" }), /chat IDs/);
    // Explicit clear removes the token (while disabling telegram, which requires a token).
    settings.update({ telegramEnabled: false, telegramChatIds: "12345", clearTelegramBotToken: true });
    stored = JSON.parse(fs.readFileSync(settings.settingsPath, "utf8"));
    assert.equal(stored.telegramBotToken, "");
    assert.equal(fs.statSync(settings.settingsPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects NaN, Infinity, negative and oversized numeric values in settings", () => {
  const dir = tmpDir("num-");
  const { IntegrationSettings } = require("../lib/integration-settings");
  const settings = new IntegrationSettings(dir);
  // integration settings are string-coerced; use an integer-bounded path instead
  const { PerformanceSettings, validate } = require("../lib/performance-settings");
  assert.throws(() => validate({ php: { memoryLimitMb: Number.NaN } }), /between/);
  assert.throws(() => validate({ php: { memoryLimitMb: Number.POSITIVE_INFINITY } }), /between/);
  assert.throws(() => validate({ php: { memoryLimitMb: -5 } }), /between/);
  assert.throws(() => validate({ php: { memoryLimitMb: 999999 } }), /between/);
  // port bounds
  const { validPort } = require("../lib/runtime-validation");
  assert.throws(() => validPort(70000), /at most 65535/);
  assert.throws(() => validPort(Number.NaN), /integer/);
});
