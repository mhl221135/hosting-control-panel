const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  BillingProvisioningClient,
  BillingProvisioningSettings,
  DEFAULTS,
} = require("../lib/billing-provisioning");

test("persists validated billing defaults and converts per-site prices to minor units", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "billing-provisioning-"));
  try {
    const settings = new BillingProvisioningSettings(root);
    assert.deepEqual(settings.read(), DEFAULTS);
    const updated = settings.update({
      enabled: true,
      freeMonths: 3,
      renewalMonths: 6,
      hostingPriceMinor: 4500,
      domainRenewalMonths: 24,
      currency: "usd",
      graceDays: 10,
      timezone: "Europe/Kyiv",
    });
    assert.equal(updated.enabled, true);
    assert.equal(updated.currency, "USD");
    const registration = settings.registration({
      register_billing: true,
      billing_grant_free_period: false,
      billing_hosting_price: "82.75",
      billing_domain_price: "19.99",
      billing_customer_name: "Example Client",
      billing_contact_email: "OWNER@EXAMPLE.COM",
    });
    assert.equal(registration.enabled, true);
    assert.equal(registration.grantFreePeriod, false);
    assert.equal(registration.hostingPriceMinor, 8275);
    assert.equal(registration.domainPriceMinor, 1999);
    assert.equal(registration.contactEmail, "owner@example.com");
    assert.throws(() => settings.update({ ...updated, currency: "US" }), /three-letter/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registers through the narrow bearer API with an idempotency key", async () => {
  let request;
  const client = new BillingProvisioningClient({
    apiUrl: "http://hosting-billing:8787/internal/v1/",
    token: "a".repeat(64),
    fetch: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 201,
        json: async () => ({
          created: true,
          service: { serviceId: "svc_provision_example_1", primaryDomain: "example.com" },
        }),
      };
    },
  });
  const payload = { primary_domain: "example.com" };
  const result = await client.register(payload, "job_1234567890abcdef");
  assert.equal(result.created, true);
  assert.equal(request.url, "http://hosting-billing:8787/internal/v1/services");
  assert.equal(request.options.headers.Authorization, `Bearer ${"a".repeat(64)}`);
  assert.equal(request.options.headers["Idempotency-Key"], "job_1234567890abcdef");
  assert.equal(request.options.body, JSON.stringify(payload));
});

test("bounds billing registration failures without exposing response bodies", async () => {
  const client = new BillingProvisioningClient({
    apiUrl: "http://hosting-billing:8787/internal/v1",
    token: "b".repeat(64),
    fetch: async () => ({
      ok: false,
      status: 503,
      json: async () => ({ message: "temporary maintenance" }),
    }),
  });
  await assert.rejects(
    client.register({ primary_domain: "example.com" }, "job_1234567890abcdef"),
    (error) => error.message === "Billing registration failed with HTTP 503"
      && error.details === "temporary maintenance",
  );
});
