const fs = require("fs");

function ensureCommerceCacheRules(content) {
  let updated = content;
  if (!updated.includes("~*OCSESSID 1;")) {
    const marker = "        ~*wp_woocommerce_session 1;";
    if (!updated.includes(marker)) throw new Error("FastCGI cookie map marker was not found");
    updated = updated.replace(marker, `${marker}\n        ~*OCSESSID 1;\n        ~*PHPSESSID 1;`);
  }
  if (!updated.includes("~*^/account 1;")) {
    const marker = "        ~*^/my-account 1;";
    if (!updated.includes(marker)) throw new Error("FastCGI URI map marker was not found");
    updated = updated.replace(marker, `${marker}\n        ~*^/account 1;\n        ~*^/admin(?:/|$) 1;`);
  }
  return updated;
}

async function migrateCommerceCache(configPath, reload) {
  const before = fs.readFileSync(configPath, "utf8");
  const after = ensureCommerceCacheRules(before);
  if (after === before) return { changed: false };
  fs.writeFileSync(configPath, after, "utf8");
  try {
    await reload();
  } catch (error) {
    fs.writeFileSync(configPath, before, "utf8");
    throw error;
  }
  return { changed: true };
}

module.exports = { ensureCommerceCacheRules, migrateCommerceCache };
