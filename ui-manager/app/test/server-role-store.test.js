const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ServerRoleStore, normalizeRole, normalizeServerId, normalizeIngressMode } = require("../lib/server-role-store");

test("normalizers reject invalid values and accept valid ones", () => {
  assert.equal(normalizeRole("primary"), "primary");
  assert.equal(normalizeRole("STANDALONE"), "standalone");
  assert.throws(() => normalizeRole("bogus"), /standalone, primary, or standby/);
  assert.equal(normalizeServerId("prod-server-1"), "prod-server-1");
  assert.throws(() => normalizeServerId("bad server name"), /Server name/);
  assert.throws(() => normalizeServerId("bad!@#"), /Server name/);
  assert.equal(normalizeIngressMode("direct_npm"), "direct_npm");
  assert.equal(normalizeIngressMode("cloudflare_tunnel"), "cloudflare_tunnel");
  assert.equal(normalizeIngressMode(""), "");
  assert.equal(normalizeIngressMode("DIRECT_NPM"), "direct_npm");
  assert.throws(() => normalizeIngressMode("weird"), /direct_npm or cloudflare_tunnel/);
});

test("defaults to standalone and reads atomically with no file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srs-"));
  try {
    const store = new ServerRoleStore({ dataDir: dir });
    const view = store.publicView();
    assert.equal(view.role, "standalone");
    assert.equal(view.ingressMode, "");
    assert.equal(view.mutable, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saves role and ingress mode atomically and tolerates missing file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srs-"));
  try {
    const store = new ServerRoleStore({ dataDir: dir });
    store.save({ role: "standby", ingress_mode: "cloudflare_tunnel" });
    const view = store.publicView();
    assert.equal(view.role, "standby");
    assert.equal(view.ingressMode, "cloudflare_tunnel");
    assert.equal(view.mutable, false);
    assert.equal(store.isStandby(), true);
    store.save({ role: "primary", ingress_mode: "direct_npm" });
    assert.equal(store.publicView().role, "primary");
    assert.equal(store.isStandby(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("partial save preserves existing fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srs-"));
  try {
    const store = new ServerRoleStore({ dataDir: dir });
    store.save({ role: "primary", server_id: "my-server" });
    const view = store.publicView();
    assert.equal(view.role, "primary");
    assert.equal(view.serverId, "my-server");
    assert.equal(view.ingressMode, ""); // unchanged from default
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("status api includes mutable flag based on standby", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srs-"));
  try {
    const store = new ServerRoleStore({ dataDir: dir });
    assert.equal(store.publicView().mutable, true);
    store.save({ role: "standby" });
    assert.equal(store.publicView().mutable, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
