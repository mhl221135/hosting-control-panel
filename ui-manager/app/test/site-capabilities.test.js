const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeSiteType, supportsWordPressRedis } = require("../lib/site-capabilities");

test("treats legacy missing site types as WordPress", () => {
  assert.equal(normalizeSiteType(), "wordpress");
  assert.equal(supportsWordPressRedis(), true);
});

test("limits WordPress Redis integration to WordPress sites", () => {
  assert.equal(supportsWordPressRedis("wordpress"), true);
  assert.equal(supportsWordPressRedis("static"), false);
  assert.equal(supportsWordPressRedis("generic-php"), false);
  assert.equal(supportsWordPressRedis("opencart"), false);
});
