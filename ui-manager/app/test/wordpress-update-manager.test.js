const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  WordPressUpdateManager,
  normalizePins,
  requestSelection,
} = require("../lib/wordpress-update-manager");

function inventory(version = "6.8.2") {
  return {
    core: version,
    coreUpdate: version === "6.8.2"
      ? { available: true, version: "6.8.3", type: "minor" }
      : { available: false, version: "", type: "" },
    plugins: [{
      name: "woocommerce",
      status: "active",
      version: version === "6.8.2" ? "9.9.0" : "9.9.1",
      update: version === "6.8.2" ? "available" : "none",
      updateVersion: version === "6.8.2" ? "9.9.1" : "",
    }],
    themes: [{
      name: "storefront",
      status: "active",
      version: "4.6.0",
      update: "none",
      updateVersion: "",
    }],
  };
}

function fixture(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wordpress-update-"));
  const registered = new Map();
  const created = [];
  const calls = [];
  let inventoryCount = 0;
  const runner = {
    async inventory() {
      inventoryCount += 1;
      return inventoryCount <= 2 ? inventory() : inventory("6.8.3");
    },
    async setMaintenanceMode(_site, enabled) { calls.push(["maintenance", enabled]); },
    async updateCore() { calls.push(["core"]); return "core updated"; },
    async updatePackages(_site, type, names) {
      calls.push([type, ...names]);
      if (options.failUpdate) throw new Error("plugin update failed");
      return names.map((name) => ({ name, message: "updated" }));
    },
    async installUploadedPackage(_site, item) { calls.push(["uploaded", item.id]); return "installed"; },
    async validateWordPress() { calls.push(["validate"]); },
  };
  const backupManager = {
    readSettings() { return { retention: 7 }; },
    async withLock(_job, work) { return work(); },
    async createSiteBackup() { calls.push(["backup"]); return { id: "2026-07-27T10-00-00Z" }; },
    async verifySiteBackup() { calls.push(["verify"]); return { ok: true }; },
    async restoreSiteBackup() { calls.push(["restore"]); return { ok: true }; },
  };
  const packageStore = {
    resolve(kind, ids) {
      return ids.map((id) => ({
        id,
        kind,
        name: `${kind}-${id}.zip`,
        path: `/app/data/${id}.zip`,
        uploadedAt: "2026-07-27T09:00:00Z",
      }));
    },
  };
  const manager = new WordPressUpdateManager({
    dataDir,
    jobManager: {
      register(type, handler) { registered.set(type, handler); },
      create(input) { created.push(input); return { id: "job-1", ...input }; },
      list() {
        return options.activeJob
          ? [{ status: "running", targets: ["example.test"], type: "wordpress.update" }]
          : [];
      },
    },
    backupManager,
    runner,
    packageStore,
    siteProvider: async () => [{
      host: "example.test",
      directory: "example.test",
      state: { siteType: "wordpress" },
    }],
    afterSuccess: async (domains) => {
      calls.push(["purge", ...domains]);
      if (options.failPurge) throw new Error("nginx reload failed");
    },
    request: async (url, requestOptions) => {
      calls.push(["http", url, requestOptions.headers.host]);
      return { status: 200, url };
    },
  });
  return { calls, created, dataDir, manager, registered };
}

function context() {
  return { update() {}, checkpoint() {} };
}

test("validates controlled update selections", () => {
  assert.throws(() => requestSelection({}), /Select at least one/);
  assert.throws(() => requestSelection({ plugins: ["bad name"] }), /invalid/);
  assert.deepEqual(requestSelection({ core: true, plugins: ["woocommerce"] }), {
    core: true,
    plugins: ["woocommerce"],
    themes: [],
    pluginPackageIds: [],
    themePackageIds: [],
  });
});

test("validates, persists, audits, and clears per-site update pins", async () => {
  const fixtureValue = fixture();
  try {
    assert.throws(() => normalizePins({ plugins: ["bad name"] }), /invalid/);
    const packageId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const saved = await fixtureValue.manager.updatePins("example.test", {
      core: true,
      plugins: ["woocommerce"],
      pluginPackageIds: [packageId],
      note: "Compatibility hold",
    }, "operator@example.test");
    assert.equal(saved.core, true);
    assert.equal(saved.note, "Compatibility hold");
    assert.equal(saved.updatedBy, "operator@example.test");
    assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(fixtureValue.manager.pinsFor("example.test").plugins, ["woocommerce"]);
    assert.equal(fs.statSync(path.join(fixtureValue.dataDir, "wordpress-update-pins.json")).mode & 0o777, 0o600);

    await fixtureValue.manager.updatePins("example.test", {}, "operator@example.test");
    assert.deepEqual(fixtureValue.manager.pinsView(), {});
  } finally {
    fs.rmSync(fixtureValue.dataDir, { recursive: true, force: true });
  }
});

test("fails closed when persisted update pins are unreadable", () => {
  const fixtureValue = fixture();
  try {
    fs.writeFileSync(path.join(fixtureValue.dataDir, "wordpress-update-pins.json"), "{broken", "utf8");
    assert.throws(() => fixtureValue.manager.pinsView(), /updates are blocked/);
  } finally {
    fs.rmSync(fixtureValue.dataDir, { recursive: true, force: true });
  }
});

test("does not change pins while the website has an active update", async () => {
  const fixtureValue = fixture({ activeJob: true });
  try {
    await assert.rejects(
      () => fixtureValue.manager.updatePins("example.test", { core: true }, "operator"),
      /active update job/,
    );
    assert.equal(fs.existsSync(path.join(fixtureValue.dataDir, "wordpress-update-pins.json")), false);
  } finally {
    fs.rmSync(fixtureValue.dataDir, { recursive: true, force: true });
  }
});

test("rejects whole-site, core, package, and uploaded-source pins during preview", async () => {
  const fixtureValue = fixture();
  const packageId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  try {
    await fixtureValue.manager.updatePins("example.test", { site: true, note: "Site hold" }, "operator");
    await assert.rejects(
      () => fixtureValue.manager.preview({ domain: "example.test", core: true }),
      /all updates for this website.*Site hold/,
    );
    await fixtureValue.manager.updatePins("example.test", {
      core: true,
      plugins: ["woocommerce"],
      pluginPackageIds: [packageId],
    }, "operator");
    await assert.rejects(
      () => fixtureValue.manager.preview({ domain: "example.test", core: true }),
      /WordPress core/,
    );
    await assert.rejects(
      () => fixtureValue.manager.preview({ domain: "example.test", plugins: ["woocommerce"] }),
      /plugin woocommerce/,
    );
    await assert.rejects(
      () => fixtureValue.manager.preview({ domain: "example.test", pluginPackageIds: [packageId] }),
      /uploaded plugin package/,
    );
  } finally {
    fs.rmSync(fixtureValue.dataDir, { recursive: true, force: true });
  }
});

test("previews current versions without mutation and queues one-site work", async () => {
  const fixtureValue = fixture();
  try {
    const preview = await fixtureValue.manager.preview({
      domain: "example.test",
      core: true,
      plugins: ["woocommerce"],
      pluginPackageIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    });
    assert.match(preview.id, /^[a-f0-9]{64}$/);
    assert.equal(preview.operations.length, 3);
    assert.equal(fixtureValue.calls.length, 0);
    const job = fixtureValue.manager.enqueue(preview, "operator@example.test");
    assert.equal(job.type, "wordpress.update");
    assert.deepEqual(job.conflicts, ["server-heavy", "site:example.test"]);
    assert.equal(job.cancellable, false);
    assert.ok(fixtureValue.registered.has("wordpress.update"));
  } finally {
    fs.rmSync(fixtureValue.dataDir, { recursive: true, force: true });
  }
});

test("a pin created after preview blocks execution before backup", async () => {
  const fixtureValue = fixture();
  try {
    const preview = await fixtureValue.manager.preview({
      domain: "example.test",
      core: true,
    });
    await fixtureValue.manager.updatePins("example.test", {
      core: true,
      note: "New compatibility finding",
    }, "operator@example.test");
    await assert.rejects(() => fixtureValue.manager.apply({
      domain: preview.domain,
      selection: preview.selection,
      previewId: preview.id,
      operator: "operator@example.test",
    }, context()), /WordPress core/);
    assert.equal(fixtureValue.calls.some((call) => call[0] === "backup"), false);
  } finally {
    fs.rmSync(fixtureValue.dataDir, { recursive: true, force: true });
  }
});

test("backs up, verifies, updates, validates, and purges only after success", async () => {
  const fixtureValue = fixture();
  try {
    const preview = await fixtureValue.manager.preview({
      domain: "example.test",
      core: true,
      plugins: ["woocommerce"],
    });
    const result = await fixtureValue.manager.apply({
      domain: preview.domain,
      selection: preview.selection,
      previewId: preview.id,
      operator: "operator@example.test",
    }, context());
    assert.equal(result.ok, true);
    assert.deepEqual(fixtureValue.calls.slice(0, 4), [
      ["backup"],
      ["verify"],
      ["maintenance", true],
      ["core"],
    ]);
    assert.ok(fixtureValue.calls.some((call) => call[0] === "validate"));
    assert.ok(fixtureValue.calls.some((call) => call[0] === "purge"));
    assert.equal(fixtureValue.calls.some((call) => call[0] === "restore"), false);
    assert.deepEqual(fixtureValue.calls.filter((call) => call[0] === "http"), [
      ["http", "http://hosting-nginx/", "example.test"],
      ["http", "http://hosting-nginx/wp-admin/", "example.test"],
    ]);
    assert.equal(fixtureValue.manager.history()[0].status, "complete");
  } finally {
    fs.rmSync(fixtureValue.dataDir, { recursive: true, force: true });
  }
});

test("automatically restores the verified backup after an update failure", async () => {
  const fixtureValue = fixture({ failUpdate: true });
  try {
    const preview = await fixtureValue.manager.preview({
      domain: "example.test",
      plugins: ["woocommerce"],
    });
    await assert.rejects(() => fixtureValue.manager.apply({
      domain: preview.domain,
      selection: preview.selection,
      previewId: preview.id,
      operator: "operator@example.test",
    }, context()), /rollback complete/);
    assert.ok(fixtureValue.calls.some((call) => call[0] === "restore"));
    assert.equal(fixtureValue.manager.history()[0].rollback, "complete");
    assert.equal(fixtureValue.manager.history()[0].status, "failed");
  } finally {
    fs.rmSync(fixtureValue.dataDir, { recursive: true, force: true });
  }
});

test("reports cache purge warnings without rolling back a healthy update", async () => {
  const fixtureValue = fixture({ failPurge: true });
  try {
    const preview = await fixtureValue.manager.preview({
      domain: "example.test",
      core: true,
    });
    const result = await fixtureValue.manager.apply({
      domain: preview.domain,
      selection: preview.selection,
      previewId: preview.id,
      operator: "operator@example.test",
    }, context());
    assert.equal(result.ok, true);
    assert.match(result.message, /cache purge warning/);
    assert.equal(fixtureValue.calls.some((call) => call[0] === "restore"), false);
  } finally {
    fs.rmSync(fixtureValue.dataDir, { recursive: true, force: true });
  }
});
