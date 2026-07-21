const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { SiteState } = require("../lib/site-state");

test("defaults OPcache on and preserves it with older site-state files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "site-state-"));
  try {
    fs.writeFileSync(
      path.join(directory, "site-state.json"),
      JSON.stringify({ sites: { "example.com": { redis: true, fastcgiCache: false } } }),
    );
    const state = new SiteState(directory, path.join(directory, "cache.map"));
    assert.equal(state.get("example.com").opcache, true);
    assert.equal(state.get("example.com").siteType, "wordpress");
    assert.equal(state.get("example.com").redis, true);
    assert.equal(state.update("example.com", { opcache: false }).opcache, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
