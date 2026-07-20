const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { IntegrationSettings } = require("../lib/integration-settings");

test("stores NPM, ACME, and Cloudflare settings without exposing secrets", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-integrations-test-"));
  try {
    const settings = new IntegrationSettings(directory);
    const publicView = settings.update({
      npmApiUrl: "http://hosting-npm:81/api",
      npmIdentity: "Owner@Example.com",
      npmSecret: "npm-password",
      acmeEmail: "Acme@Example.com",
      cloudflareToken: "cloudflare-token",
      cloudflareAccountId: "0123456789abcdef0123456789abcdef",
      mysqlContainer: "hosting-db",
      mysqlSitePrefix: "site_",
    });
    assert.equal(publicView.npmIdentity, "owner@example.com");
    assert.equal(publicView.acmeEmail, "acme@example.com");
    assert.equal(publicView.npmSecretConfigured, true);
    assert.equal(publicView.cloudflareAccountId, "0123456789abcdef0123456789abcdef");
    assert.equal(settings.resolved().npmSecret, "npm-password");
    assert.equal(settings.resolved().cloudflareToken, "cloudflare-token");
    assert.doesNotMatch(fs.readFileSync(settings.settingsPath, "utf8"), /npm-password|cloudflare-token/);
    assert.throws(() => settings.update({ acmeEmail: "invalid" }), /valid ACME email/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
