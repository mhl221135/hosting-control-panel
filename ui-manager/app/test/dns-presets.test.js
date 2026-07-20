const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DnsPresetStore } = require("../lib/dns-presets");
const { IpAddressStore } = require("../lib/ip-addresses");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-dns-test-"));
  return {
    root,
    presets: new DnsPresetStore(root),
    addresses: new IpAddressStore(root),
  };
}

test("saves, updates and resolves DNS presets for a selected host", () => {
  const value = fixture();
  try {
    const created = value.presets.save({
      label: "WWW target",
      type: "CNAME",
      name_template: "www",
      content_template: "{domain}",
      proxied: true,
      ttl: 1,
    });
    assert.equal(value.presets.resolve(created.id, "example.com").name, "www.example.com");
    assert.equal(value.presets.resolve(created.id, "example.com").content, "example.com");
    const updated = value.presets.save({ ...created, label: "Updated", contentTemplate: "origin.example.net" });
    assert.equal(updated.id, created.id);
    assert.equal(value.presets.read()[0].label, "Updated");
    value.presets.delete(created.id);
    assert.deepEqual(value.presets.read(), []);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("resolves @ and full host templates without duplicating the domain", () => {
  const value = fixture();
  try {
    const apex = value.presets.save({ label: "Apex", type: "A", name_template: "@", content_template: "192.0.2.10" });
    const full = value.presets.save({
      label: "Full",
      type: "TXT",
      name_template: "_verify.{domain}",
      content_template: "verified",
    });
    assert.equal(value.presets.resolve(apex.id, "example.com").name, "example.com");
    assert.equal(value.presets.resolve(full.id, "example.com").name, "_verify.example.com");
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("stores unique IPv4 addresses and rejects IPv6 or invalid input", () => {
  const value = fixture();
  try {
    assert.deepEqual(
      value.addresses.save(["192.0.2.1", "192.0.2.1", "198.51.100.9"]),
      ["192.0.2.1", "198.51.100.9"],
    );
    assert.throws(() => value.addresses.save(["2001:db8::1"]), /Invalid IPv4/);
    assert.throws(() => value.addresses.save(["not-an-ip"]), /Invalid IPv4/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
