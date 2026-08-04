const assert = require("node:assert/strict");
const test = require("node:test");
const {
  boundedInteger,
  boundedSlug,
  boundedStringsArray,
  documentRoot,
  durationSeconds,
  guardBody,
  hasPollutionKey,
  optionalBoolean,
  processManager,
  rejectUnknownKeys,
  validHostname,
  validPort,
} = require("../lib/runtime-validation");

test("guardBody accepts safe objects and rejects non-object bodies", () => {
  assert.deepEqual(guardBody({ a: 1 }), { a: 1 });
  assert.deepEqual(guardBody(null), {});
  assert.throws(() => guardBody([1, 2]), /JSON object/);
  assert.throws(() => guardBody("x"), /JSON object/);
  assert.throws(() => guardBody(42), /JSON object/);
});

test("guardBody rejects prototype-pollution keys", () => {
  assert.equal(hasPollutionKey(JSON.parse('{"__proto__":{"x":1}}')), true);
  assert.equal(hasPollutionKey(JSON.parse('{"constructor":{"prototype":{}}}')), true);
  assert.equal(hasPollutionKey(JSON.parse('{"a":{"b":{"prototype":{}}}}')), true);
  assert.equal(hasPollutionKey({ a: 1 }), false);
  assert.throws(() => guardBody(JSON.parse('{"a":{"__proto__":{"x":1}}}')), /Unsupported request key/);
  assert.throws(() => guardBody(JSON.parse('{"constructor":{}}')), /Unsupported request key/);
});

test("guardBody rejects oversized structures", () => {
  const big = Array.from({ length: 5000 }, (_, i) => [i]).map(([i]) => ({ n: i }));
  assert.throws(() => guardBody({ rows: big }, { maxKeys: 100 }), /too large/);
});

test("validHostname accepts valid and rejects malformed hosts", () => {
  assert.equal(validHostname("Example.COM"), "example.com");
  assert.equal(validHostname("a.example.com"), "a.example.com");
  assert.throws(() => validHostname(""), /valid hostname/);
  assert.throws(() => validHostname("nope"), /valid hostname/);
  assert.throws(() => validHostname("bad..example.com"), /malformed|valid hostname/);
  assert.throws(() => validHostname("-bad.example.com"), /malformed|valid hostname/);
  assert.throws(() => validHostname("bad-.example.com"), /malformed|valid hostname/);
});

test("documentRoot rejects traversal and non /var/www roots", () => {
  assert.equal(documentRoot("/var/www/site"), "/var/www/site");
  assert.throws(() => documentRoot("/var/www/../../etc"), /path traversal/);
  assert.throws(() => documentRoot("/etc/passwd"), /under \/var\/www/);
  assert.throws(() => documentRoot(""), /required/);
});

test("validPort accepts 1..65535 and rejects others", () => {
  assert.equal(validPort("9001"), 9001);
  assert.equal(validPort(9000), 9000);
  assert.equal(validPort(null, { allowNull: true }), null);
  assert.throws(() => validPort("bogus"), /integer/);
  assert.throws(() => validPort(0), /at least 1/);
  assert.throws(() => validPort(70000), /at most 65535/);
  assert.throws(() => validPort(1.5), /integer/);
});

test("boundedInteger and durationSeconds bound values", () => {
  assert.equal(boundedInteger("5", { min: 1, max: 100, label: "workers" }), 5);
  assert.throws(() => boundedInteger(Number.NaN, { min: 1, max: 100, label: "workers" }), /integer/);
  assert.throws(() => boundedInteger(2.5, { min: 1, max: 100, label: "workers" }), /integer/);
  assert.throws(() => boundedInteger(-1, { min: 0, max: 100, label: "workers" }), /at least 0/);
  assert.equal(durationSeconds("30s"), "30s");
  assert.throws(() => durationSeconds("9000s"), /duration/);
  assert.throws(() => durationSeconds("30"), /duration/);
  assert.throws(() => durationSeconds("x"), /duration/);
});

test("boundedSlug and boundedStringsArray bound names and arrays", () => {
  assert.equal(boundedSlug("pool_1"), "pool_1");
  assert.throws(() => boundedSlug("pool/name"), /unsupported characters/);
  assert.throws(() => boundedSlug(""), /required/);
  assert.throws(() => boundedSlug("a".repeat(500)), /too long/);
  assert.deepEqual(boundedStringsArray(["a", " b ", ""]), ["a", "b"]);
  assert.throws(() => boundedStringsArray("nope"), /must be an array/);
});

test("processManager, optionalBoolean behave", () => {
  assert.equal(processManager("ondemand"), "ondemand");
  assert.throws(() => processManager("weird"), /Invalid process manager/);
  assert.equal(optionalBoolean(true), true);
  assert.equal(optionalBoolean(undefined, true), true);
  assert.throws(() => optionalBoolean(1), /boolean/);
});

test("rejectUnknownKeys returns the object when all keys allowed", () => {
  const obj = { name: "x", port: 9001 };
  assert.equal(rejectUnknownKeys(obj, new Set(["name", "port"])), obj);
});
