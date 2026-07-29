const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  BillingProvisioningClient,
  BillingProvisioningSettings,
  DEFAULTS,
  hasBillingWarning,
  registrationPayload,
  retryJobInput,
  retryRegistration,
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

test("builds the same bounded registration for initial and retry attempts", () => {
  const payload = registrationPayload("example.com", {
    add_www: true,
    admin_email: "owner@example.com",
    notes: "Provisioned by the panel",
  }, {
    customerName: "Example Client",
    contactEmail: "",
    grantFreePeriod: true,
    freeMonths: 6,
    renewalMonths: 12,
    hostingPriceMinor: 8000,
    domainRenewalMonths: 12,
    domainPriceMinor: 1499,
    domainPaidThrough: "2027-01-31",
    currency: "USD",
    graceDays: 7,
    timezone: "Europe/Kyiv",
  }, "2026-07-29");
  assert.deepEqual(payload.aliases, ["www.example.com"]);
  assert.equal(payload.contact_email, "owner@example.com");
  assert.equal(payload.hosting_price_minor, 8000);
  assert.equal(payload.domain_paid_through, "2027-01-31");
  assert.equal(payload.trial_anchor, "2026-07-29");
});

test("queues a billing-only retry only for a completed billing warning", () => {
  const source = {
    id: "11111111-1111-4111-8111-111111111111",
    type: "site.provision",
    status: "partially_succeeded",
    targets: ["example.com"],
    results: [
      { name: "runtime", ok: true },
      { name: "billing", ok: false, message: "Billing unavailable" },
    ],
  };
  assert.equal(hasBillingWarning(source), true);
  const input = retryJobInput(source, "admin@example.com");
  assert.equal(input.type, "billing.provision.retry");
  assert.deepEqual(input.conflicts, ["site:example.com"]);
  assert.deepEqual(input.payload, { sourceJobId: source.id });
  assert.equal(input.retryOf, source.id);
  assert.equal(input.retryable, false);
  assert.equal(JSON.stringify(input).includes("Billing unavailable"), false);
  assert.throws(
    () => retryJobInput({ ...source, results: [{ name: "npm", ok: false }] }, "admin@example.com"),
    /no retryable billing warning/,
  );
});

test("retries with the original idempotency key and trial anchor", async () => {
  const source = {
    id: "22222222-2222-4222-8222-222222222222",
    type: "site.provision",
    status: "partially_succeeded",
    targets: ["example.com"],
    finishedAt: "2026-07-29T08:15:00.000Z",
    payload: {
      request: {
        domain: "example.com",
        admin_email: "owner@example.com",
        register_billing: true,
        billing_grant_free_period: true,
      },
    },
    results: [{ name: "billing", ok: false }],
  };
  let call;
  const result = await retryRegistration(source, {
    registration: () => ({
      enabled: true,
      customerName: "",
      contactEmail: "",
      grantFreePeriod: true,
      freeMonths: 6,
      renewalMonths: 12,
      hostingPriceMinor: 8000,
      domainRenewalMonths: 12,
      domainPriceMinor: 0,
      domainPaidThrough: "",
      currency: "USD",
      graceDays: 7,
      timezone: "Europe/Kyiv",
    }),
  }, {
    register: async (payload, key) => {
      call = { payload, key };
      return { created: true, service: { serviceId: "svc_example" } };
    },
  });
  assert.equal(call.key, source.id);
  assert.equal(call.payload.trial_anchor, "2026-07-29");
  assert.equal(result.domain, "example.com");
  assert.equal(result.result.service.serviceId, "svc_example");
});
