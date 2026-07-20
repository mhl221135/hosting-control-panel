const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WordPressPackageStore } = require("../lib/wordpress-packages");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-wordpress-packages-test-"));
  return { root, store: new WordPressPackageStore(root) };
}

test("stores, lists, resolves and deletes WordPress ZIP packages", () => {
  const value = fixture();
  try {
    const uploaded = value.store.upload("plugins", "custom-plugin.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
    assert.equal(uploaded.name, "custom-plugin.zip");
    assert.equal(value.store.publicView().plugins.length, 1);
    const selected = value.store.resolve("plugins", [uploaded.id, uploaded.id]);
    assert.equal(selected.length, 1);
    assert.equal(fs.existsSync(selected[0].path), true);
    value.store.delete("plugins", uploaded.id);
    assert.equal(value.store.publicView().plugins.length, 0);
    assert.equal(fs.existsSync(selected[0].path), false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects invalid package types, files and stale selections", () => {
  const value = fixture();
  try {
    assert.throws(() => value.store.upload("mu-plugins", "plugin.zip", Buffer.from("PK00")), /plugins or themes/);
    assert.throws(() => value.store.upload("plugins", "plugin.txt", Buffer.from("PK00")), /ZIP package/);
    assert.throws(() => value.store.upload("themes", "theme.zip", Buffer.from("not zip")), /valid ZIP/);
    assert.throws(() => value.store.resolve("themes", ["missing"]), /no longer available/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
