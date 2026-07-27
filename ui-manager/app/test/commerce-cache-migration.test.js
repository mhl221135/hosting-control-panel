const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ensureCommerceCacheRules, migrateCommerceCache } = require("../lib/commerce-cache-migration");

const BASE = `map $http_cookie $skip_cache_cookie {
        ~*wp_woocommerce_session 1;
}
map $request_uri $skip_cache_uri {
        ~*^/my-account 1;
}
`;

test("adds OpenCart session and route exclusions idempotently", () => {
  const migrated = ensureCommerceCacheRules(BASE);
  assert.match(migrated, /OCSESSID/);
  assert.match(migrated, /PHPSESSID/);
  assert.match(migrated, /\^\/account/);
  assert.match(migrated, /\^\/admin/);
  assert.equal(ensureCommerceCacheRules(migrated), migrated);
});

test("restores nginx configuration when validation or reload fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "commerce-cache-test-"));
  const configPath = path.join(directory, "nginx.conf");
  try {
    fs.writeFileSync(configPath, BASE);
    await assert.rejects(
      migrateCommerceCache(configPath, async () => { throw new Error("invalid nginx"); }),
      /invalid nginx/,
    );
    assert.equal(fs.readFileSync(configPath, "utf8"), BASE);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
