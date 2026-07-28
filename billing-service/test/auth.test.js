const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AuthStore, apiAuthorized } = require("../app/lib/auth");

function request(cookie = "", authorization = "") {
  return {
    headers: { cookie, authorization },
    socket: { remoteAddress: "127.0.0.1" },
  };
}

test("hashes the independent administrator password and rotates session CSRF", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-billing-auth-"));
  const previousEmail = process.env.BILLING_ADMIN_EMAIL;
  const previousPassword = process.env.BILLING_ADMIN_PASSWORD;
  process.env.BILLING_ADMIN_EMAIL = "billing@example.com";
  process.env.BILLING_ADMIN_PASSWORD = "initial-password-123";
  try {
    const auth = new AuthStore(root);
    const accountText = fs.readFileSync(path.join(root, "admin-account.json"), "utf8");
    assert.doesNotMatch(accountText, /initial-password-123/);
    const session = auth.login(request(), "billing@example.com", "initial-password-123");
    const before = session.csrf;
    auth.update(session, "initial-password-123", "new@example.com", "replacement-password-123");
    assert.notEqual(session.csrf, before);
    assert.equal(auth.session(request(`billing_session=${session.id}`)).email, "new@example.com");
  } finally {
    if (previousEmail === undefined) delete process.env.BILLING_ADMIN_EMAIL;
    else process.env.BILLING_ADMIN_EMAIL = previousEmail;
    if (previousPassword === undefined) delete process.env.BILLING_ADMIN_PASSWORD;
    else process.env.BILLING_ADMIN_PASSWORD = previousPassword;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requires a long timing-safe bearer token for the internal API", () => {
  const previous = process.env.BILLING_API_TOKEN;
  process.env.BILLING_API_TOKEN = "a".repeat(64);
  try {
    assert.equal(apiAuthorized(request("", `Bearer ${"a".repeat(64)}`)), true);
    assert.equal(apiAuthorized(request("", `Bearer ${"b".repeat(64)}`)), false);
    assert.equal(apiAuthorized(request()), false);
  } finally {
    if (previous === undefined) delete process.env.BILLING_API_TOKEN;
    else process.env.BILLING_API_TOKEN = previous;
  }
});
