const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeSiteType, siteAdapter, siteDatabaseReference } = require("../lib/site-capabilities");

test("normalizes supported adapters and keeps legacy unknown values on WordPress", () => {
  assert.equal(normalizeSiteType("generic-php"), "generic-php");
  assert.equal(normalizeSiteType("static"), "static");
  assert.equal(normalizeSiteType("opencart"), "opencart");
  assert.equal(normalizeSiteType("legacy"), "wordpress");
});

test("declares capability-driven database and cache behavior", () => {
  assert.equal(siteAdapter("wordpress").database, "required");
  assert.equal(siteAdapter("generic-php").database, "optional");
  assert.equal(siteAdapter("generic-php").redis, false);
  assert.equal(siteAdapter("opencart").database, "required");
  assert.equal(siteAdapter("opencart").updates, false);
  assert.equal(siteAdapter("static").php, false);
  assert.equal(siteDatabaseReference({ state: { siteType: "generic-php" } }), null);
  assert.deepEqual(siteDatabaseReference({
    state: { siteType: "generic-php", databaseName: "site_db", databaseUser: "site_user" },
  }), { name: "site_db", user: "site_user" });
  assert.deepEqual(siteDatabaseReference({
    state: { siteType: "opencart", databaseName: "cart_db", databaseUser: "cart_user" },
  }), { name: "cart_db", user: "cart_user" });
});
