const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { inspectOpenCart, rewriteOpenCart } = require("../lib/opencart");

function config(root, application, admin = false) {
  return `<?php
define('HTTP_SERVER', 'http://old.example/${admin ? "control/" : ""}');
define('HTTPS_SERVER', 'https://old.example/${admin ? "control/" : ""}');
${admin ? "define('HTTP_CATALOG', 'http://old.example/');\ndefine('HTTPS_CATALOG', 'https://old.example/');" : ""}
define('DIR_APPLICATION', '${root}/${application}/');
define('DIR_SYSTEM', '${root}/system/');
define('DIR_IMAGE', '${root}/image/');
define('DIR_STORAGE', '${root}/system/storage/');
define('DIR_LANGUAGE', '${root}/${application}/language/');
define('DIR_TEMPLATE', '${root}/${application}/view/template/');
define('DIR_CONFIG', '${root}/system/config/');
define('DIR_CACHE', '${root}/system/storage/cache/');
define('DIR_DOWNLOAD', '${root}/system/storage/download/');
define('DIR_LOGS', '${root}/system/storage/logs/');
define('DIR_MODIFICATION', '${root}/system/storage/modification/');
define('DIR_SESSION', '${root}/system/storage/session/');
define('DIR_UPLOAD', '${root}/system/storage/upload/');
${admin ? `define('DIR_CATALOG', '${root}/catalog/');` : ""}
define('DB_HOSTNAME', 'localhost');
define('DB_USERNAME', 'old_user');
define('DB_PASSWORD', 'old_password');
define('DB_DATABASE', 'old_database');
define('DB_PORT', '3306');
`;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencart-test-"));
  for (const directory of ["catalog", "system/storage", "image", "control"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "index.php"), "<?php");
  fs.writeFileSync(path.join(root, "control", "index.php"), "<?php");
  fs.writeFileSync(path.join(root, "config.php"), config("/old/path", "catalog"));
  fs.writeFileSync(path.join(root, "control", "config.php"), config("/old/path", "control", true));
  return root;
}

test("detects OpenCart and its renamed admin directory", () => {
  const root = fixture();
  try {
    const result = inspectOpenCart(root);
    assert.equal(result.adminDirectory, "control");
    assert.equal(result.database, "old_database");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rewrites OpenCart URLs, database credentials, and absolute paths", () => {
  const root = fixture();
  try {
    rewriteOpenCart(root, {
      domain: "shop.example.com",
      useHttps: true,
      containerRoot: "/var/www/shop.example.com",
      database: { name: "shop_db", user: "shop_user", password: "a'password" },
    });
    const storefront = fs.readFileSync(path.join(root, "config.php"), "utf8");
    const admin = fs.readFileSync(path.join(root, "control", "config.php"), "utf8");
    assert.match(storefront, /https:\/\/shop\.example\.com\//);
    assert.match(storefront, /define\('DB_DATABASE', 'shop_db'\)/);
    assert.match(storefront, /define\('DB_PASSWORD', 'a\\'password'\)/);
    assert.match(storefront, /\/var\/www\/shop\.example\.com\/catalog\//);
    assert.match(admin, /https:\/\/shop\.example\.com\/control\//);
    assert.match(admin, /define\('HTTP_CATALOG', 'https:\/\/shop\.example\.com\/'\)/);
    assert.match(admin, /define\('DIR_CATALOG', '\/var\/www\/shop\.example\.com\/catalog\/'\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects incomplete OpenCart layouts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencart-invalid-"));
  try {
    fs.writeFileSync(path.join(root, "index.php"), "<?php");
    assert.throws(() => inspectOpenCart(root), /config\.php/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
