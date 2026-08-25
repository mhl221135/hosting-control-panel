const assert = require("node:assert/strict");
const test = require("node:test");
const { hostsFromMap, options, zoneForHost } = require("../cli/reconcile-cloudflare-host-dns");

test("extracts only configured website hostnames from nginx maps", () => {
  const content = `map $host $site_root {
    default /var/www/_default;
    example.com /var/www/example.com;
    www.example.com /var/www/example.com;
    $host /var/www/not-a-host;
  }`;
  assert.deepEqual(hostsFromMap(content), ["example.com", "www.example.com"]);
});

test("requires explicit apply confirmation and IPv4", () => {
  assert.equal(options(["node", "cli", "--preview", "--ip", "192.0.2.1"]).mode, "preview");
  assert.throws(() => options(["node", "cli", "--apply", "--ip", "192.0.2.1"]), /RECONCILE-HOST-DNS/);
  assert.throws(() => options(["node", "cli", "--preview", "--ip", "not-ip"]), /IPv4/);
});

test("selects the longest matching managed zone", () => {
  assert.equal(zoneForHost([
    { id: "one", name: "example.com" },
    { id: "two", name: "sub.example.com" },
  ], "www.sub.example.com").id, "two");
});
