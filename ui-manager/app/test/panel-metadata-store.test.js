const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PanelMetadataStore, normalizeIngressMode } = require("../lib/panel-metadata-store");

test("normalizeIngressMode accepts valid and rejects invalid", () => {
  assert.equal(normalizeIngressMode("direct_npm"), "direct_npm");
  assert.equal(normalizeIngressMode("cloudflare_tunnel"), "cloudflare_tunnel");
  assert.equal(normalizeIngressMode(""), "");
  assert.equal(normalizeIngressMode("CLOUDFLARE_TUNNEL"), "cloudflare_tunnel");
  assert.throws(() => normalizeIngressMode("bogus"), /direct_npm or cloudflare_tunnel/);
});

test("defaults to empty ingress mode and persists atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-"));
  try {
    const store = new PanelMetadataStore({ dataDir: dir });
    const view = store.publicView();
    assert.equal(view.ingressMode, "");
    store.save({ ingress_mode: "cloudflare_tunnel" });
    assert.equal(store.read().ingressMode, "cloudflare_tunnel");
    store.save({ ingress_mode: "" });
    assert.equal(store.read().ingressMode, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("panel metadata store never exposes or persists a role field", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pms-"));
  try {
    const store = new PanelMetadataStore({ dataDir: dir });
    assert.equal("role" in store.publicView(), false);
    store.save({ ingress_mode: "direct_npm" });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "server-role.json"), "utf8"));
    assert.equal("role" in raw, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});