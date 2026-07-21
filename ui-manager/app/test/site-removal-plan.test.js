const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSiteRemovalPlan } = require("../lib/site-removal-plan");

function baseInput() {
  return {
    site: { host: "example.com", aliases: ["www.example.com"], root: "/var/www/example.com", port: 9001, poolName: "example_com" },
    allSites: [
      { host: "example.com", root: "/var/www/example.com", port: 9001 },
      { host: "www.example.com", root: "/var/www/example.com", port: 9001 },
    ],
    database: { name: "site_db", user: "site_user" },
    databaseReferences: [{ domain: "example.com", name: "site_db", user: "site_user" }],
    databaseInspectionComplete: true,
    npmHosts: [{ id: 4, domain_names: ["example.com", "www.example.com"], certificate_id: 7 }],
    certificates: [{ id: 7, nice_name: "example.com", domain_names: ["example.com", "www.example.com"] }],
    dnsRecords: [{ id: "dns-1", type: "A", name: "example.com" }],
    backups: [{ id: "backup-1" }],
  };
}

test("builds a complete safe removal plan for exclusively owned resources", () => {
  const plan = buildSiteRemovalPlan(baseInput());
  assert.deepEqual(plan.targetDomains, ["example.com", "www.example.com"]);
  assert.equal(plan.resources.pool.safe, true);
  assert.equal(plan.resources.files.safe, true);
  assert.equal(plan.resources.database.safe, true);
  assert.equal(plan.resources.npmHost.safe, true);
  assert.equal(plan.resources.npmCertificate.safe, true);
});

test("can identify an orphaned site certificate after its NPM host is gone", () => {
  const input = baseInput();
  input.npmHosts = [];
  const plan = buildSiteRemovalPlan(input);
  assert.equal(plan.resources.npmHost.available, false);
  assert.equal(plan.resources.npmCertificate.available, true);
  assert.equal(plan.resources.npmCertificate.safe, true);
});

test("marks shared pools, roots, databases, NPM hosts, and certificates unsafe", () => {
  const input = baseInput();
  input.allSites.push({ host: "other.example", root: "/var/www/example.com", port: 9001 });
  input.databaseReferences.push({ domain: "other.example", name: "site_db", user: "site_user" });
  input.npmHosts[0].domain_names.push("other.example");
  input.npmHosts.push({ id: 5, domain_names: ["unrelated.example"], certificate_id: 7 });
  const plan = buildSiteRemovalPlan(input);
  assert.equal(plan.resources.pool.safe, false);
  assert.equal(plan.resources.files.safe, false);
  assert.equal(plan.resources.database.safe, false);
  assert.equal(plan.resources.npmHost.safe, false);
  assert.equal(plan.resources.npmCertificate.safe, false);
});

test("allows a final file-only backup for a static PHP site", () => {
  const input = baseInput();
  input.site.state = { siteType: "static" };
  input.database = null;
  input.databaseReferences = [];
  const plan = buildSiteRemovalPlan(input);
  assert.equal(plan.resources.database.available, false);
  assert.equal(plan.resources.finalBackup.available, true);
  assert.equal(plan.resources.finalBackup.safe, true);
});
