const assert = require("node:assert/strict");
const test = require("node:test");
const { CloudflareClient, NpmClient } = require("../lib/integrations");

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("lists records at the selected host and below it", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes("/zones?name=example.com")) {
      return response({ success: true, result: [{ id: "zone-1", name: "example.com" }] });
    }
    if (url.includes("/dns_records?per_page=5000")) {
      return response({
        success: true,
        result: [
          { id: "1", type: "A", name: "example.com", content: "192.0.2.1" },
          { id: "2", type: "CNAME", name: "www.example.com", content: "example.com" },
          { id: "3", type: "A", name: "unrelated.example.net", content: "192.0.2.2" },
        ],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const client = new CloudflareClient(() => ({ cloudflareToken: "test-token" }));
    const result = await client.records("example.com");
    assert.deepEqual(result.records.map((record) => record.id), ["1", "2"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("replaces only exact matching A records and preserves Cloudflare settings", async () => {
  const originalFetch = global.fetch;
  const updates = [];
  global.fetch = async (url, options = {}) => {
    if (url.includes("/zones?status=active")) {
      return response({
        success: true,
        result: [{ id: "zone-1", name: "example.com" }],
        result_info: { total_pages: 1 },
      });
    }
    if (url.includes("/dns_records?type=A&content=192.0.2.1")) {
      return response({
        success: true,
        result: [{
          id: "record-1",
          type: "A",
          name: "example.com",
          content: "192.0.2.1",
          ttl: 300,
          proxied: true,
          comment: "primary",
          tags: ["server:old"],
        }],
      });
    }
    if (url.includes("/dns_records/record-1") && options.method === "PUT") {
      updates.push(JSON.parse(options.body));
      return response({ success: true, result: { id: "record-1" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const client = new CloudflareClient(() => ({ cloudflareToken: "test-token" }));
    const result = await client.replaceARecords("192.0.2.1", "198.51.100.20");
    assert.equal(result.changed, 1);
    assert.deepEqual(updates[0], {
      type: "A",
      name: "example.com",
      content: "198.51.100.20",
      ttl: 300,
      proxied: true,
      comment: "primary",
      tags: ["server:old"],
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("verifies account-owned tokens with the account endpoint", async () => {
  const originalFetch = global.fetch;
  let requestedUrl = "";
  global.fetch = async (url) => {
    requestedUrl = url;
    return response({ success: true, result: { id: "token-1", status: "active" } });
  };
  try {
    const client = new CloudflareClient(() => ({
      cloudflareToken: "cfat_test-token",
      cloudflareAccountId: "0123456789abcdef0123456789abcdef",
    }));
    const result = await client.verify();
    assert.equal(result.status, "active");
    assert.match(requestedUrl, /accounts\/0123456789abcdef0123456789abcdef\/tokens\/verify$/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("normalizes an existing legacy website proxy target", async () => {
  const client = new NpmClient(() => ({
    npmApiUrl: "http://npm.test/api",
    npmIdentity: "owner@example.com",
    npmSecret: "secret",
  }));
  client.createHost = async () => ({
    id: 5,
    domain_names: ["example.com"],
    forward_scheme: "http",
    forward_host: "wp-example-com",
    forward_port: 80,
    certificate_id: 12,
    enabled: true,
  });
  let update = null;
  client.updateHost = async (host, overrides) => {
    update = { host, overrides };
    return { ...host, ...overrides };
  };
  const result = await client.ensureHost(["example.com"], false);
  assert.equal(result.forward_host, "hosting-nginx");
  assert.equal(result.forward_port, 80);
  assert.equal(update.host.id, 5);
  assert.equal(result.certificate_id, 12);
});
