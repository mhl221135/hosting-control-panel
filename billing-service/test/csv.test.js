const assert = require("node:assert/strict");
const test = require("node:test");
const { exportCsv, importCsv, parseCsv } = require("../app/lib/csv");
const { normalizeService, stateForDate } = require("../app/lib/validation");

test("parses quoted CSV and maps the legacy hosting inventory", () => {
  const csv = [
    "Order #,Client Type,Website,Hosting,Hosting Next Payment,Domain Next Payment,Hosting Months,Price Hosting,Price Domain,Email,Phone",
    '42,Client,Example.COM,local,"Jul 1, 2026",07/15/2026,12,"$120.50",$18.25,owner@example.com,+1-555',
  ].join("\r\n");
  const parsed = importCsv(csv);
  assert.equal(parsed.services.length, 1);
  assert.equal(parsed.services[0].service_id.length, 28);
  assert.equal(parsed.services[0].primary_domain, "example.com");
  assert.equal(parsed.services[0].hosting_paid_through, "2026-07-01");
  assert.equal(parsed.services[0].hosting_price_minor, 12050);
  assert.equal(parsed.services[0].source_ref, "42");
});

test("canonical export round trips stable IDs and aliases", () => {
  const original = normalizeService({
    service_id: "svc_stable_example_001",
    primary_domain: "example.com",
    aliases: ["www.example.com"],
    customer_name: "Example",
    hosting_paid_through: "2026-12-31",
    hosting_price_minor: 24000,
  });
  const reparsed = importCsv(exportCsv([original])).services[0];
  assert.deepEqual(reparsed, original);
});

test("rejects malformed, duplicate, and oversized CSV input", () => {
  assert.throws(() => parseCsv('Website\n"example.com'), /unterminated/);
  assert.throws(() => importCsv("Website\nexample.com\nexample.com"), /Duplicate (service ID|primary domain)/);
  assert.throws(() => parseCsv(`Website\n${"a".repeat(5 * 1024 * 1024)}`), /5 MB/);
});

test("calculates active, reminder, grace, suspended and fail-open exempt states", () => {
  const now = new Date("2026-07-28T12:00:00Z");
  const settings = { reminderDays: 30, graceDays: 7 };
  assert.equal(stateForDate("2026-12-01", settings, "", now), "active");
  assert.equal(stateForDate("2026-08-10", settings, "", now), "reminder");
  assert.equal(stateForDate("2026-07-25", settings, "", now), "grace");
  assert.equal(stateForDate("2026-07-01", settings, "", now), "suspended");
  assert.equal(stateForDate("", settings, "", now), "exempt");
  assert.equal(stateForDate("2020-01-01", settings, "active", now), "active");
});
