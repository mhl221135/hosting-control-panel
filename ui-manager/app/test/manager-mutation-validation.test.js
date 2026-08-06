const assert = require("node:assert/strict");
const test = require("node:test");
const {
  requirePrimarySite,
  validateCachePurgeMutation,
  validateImageSettingsMutation,
  validateMaintenanceSettingsMutation,
  validateSiteStateMutation,
  validateUpdatePinsMutation,
} = require("../lib/manager-mutation-validation");

test("primary-site validation rejects shared-root www aliases without redirects", () => {
  const mapParsed = { hosts: {
    "example.com": { host: "example.com", root: "/var/www/example.com", port: 9001, canonicalTo: "" },
    "www.example.com": { host: "www.example.com", root: "/var/www/example.com", port: 9001, canonicalTo: "" },
  } };
  assert.equal(requirePrimarySite(mapParsed, "example.com").host, "example.com");
  assert.throws(() => requirePrimarySite(mapParsed, "www.example.com"), /Primary website/);
});

test("site-state and cache-purge mutations require exact input types", () => {
  assert.equal(validateSiteStateMutation({ domain: "example.com", redis: true, notes: "ok" }).redis, true);
  assert.throws(() => validateSiteStateMutation({ domain: "example.com", redis: "true" }), /boolean/);
  assert.throws(() => validateSiteStateMutation({ domain: "example.com", notes: "x".repeat(2001) }), /too long/);
  assert.throws(() => validateCachePurgeMutation({ domain: 123 }), /string/);
});

test("image and maintenance settings reject coercible malformed values", () => {
  validateImageSettingsMutation({ enabled: false, schedule_time: "02:30" });
  assert.throws(() => validateImageSettingsMutation({ enabled: 0 }), /boolean/);
  validateMaintenanceSettingsMutation({ enabled: true, weekday: 2, revision_retention: 5, operations: ["cron"] });
  assert.throws(() => validateMaintenanceSettingsMutation({ weekday: "2" }), /integer/);
  assert.throws(() => validateMaintenanceSettingsMutation({ revision_retention: 5.5 }), /integer/);
  assert.throws(() => validateMaintenanceSettingsMutation({ operations: "cron" }), /array/);
  assert.throws(() => validateMaintenanceSettingsMutation({ operations: [1] }), /string/);
});

test("update pins reject wrong booleans, arrays, and over-long notes", () => {
  validateUpdatePinsMutation({ domain: "example.com", site: true, plugins: ["plugin-name"], note: "hold" });
  assert.throws(() => validateUpdatePinsMutation({ domain: "example.com", core: 1 }), /boolean/);
  assert.throws(() => validateUpdatePinsMutation({ domain: "example.com", plugins: "plugin-name" }), /array/);
  assert.throws(() => validateUpdatePinsMutation({ domain: "example.com", plugins: [false] }), /string/);
  assert.throws(() => validateUpdatePinsMutation({ domain: "example.com", note: "x".repeat(301) }), /too long/);
});
