const assert = require("node:assert/strict");
const test = require("node:test");
const { HaPeerAuth } = require("../lib/ha-peer-auth");

test("requires a strong configured token and exact bearer authentication", () => {
  assert.equal(new HaPeerAuth({ token: "short" }).configured(), false);
  const auth = new HaPeerAuth({ token: "a".repeat(48) });
  assert.equal(auth.configured(), true);
  assert.equal(auth.authorized(`Bearer ${"a".repeat(48)}`), true);
  assert.equal(auth.authorized(`Bearer ${"b".repeat(48)}`), false);
  assert.equal(auth.authorized("Basic hidden"), false);
});
