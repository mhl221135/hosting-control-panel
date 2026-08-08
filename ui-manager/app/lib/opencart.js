const fs = require("fs");
const path = require("path");

const CONFIG_KEYS = [
  "HTTP_SERVER", "HTTPS_SERVER", "HTTP_CATALOG", "HTTPS_CATALOG",
  "DB_HOSTNAME", "DB_USERNAME", "DB_PASSWORD", "DB_DATABASE", "DB_PORT",
  "DIR_APPLICATION", "DIR_SYSTEM", "DIR_IMAGE", "DIR_STORAGE", "DIR_LANGUAGE",
  "DIR_TEMPLATE", "DIR_CONFIG", "DIR_CACHE", "DIR_DOWNLOAD", "DIR_LOGS",
  "DIR_MODIFICATION", "DIR_SESSION", "DIR_UPLOAD", "DIR_CATALOG",
];
const REQUIRED_KEYS = new Set([
  "HTTP_SERVER", "HTTPS_SERVER", "DB_HOSTNAME", "DB_USERNAME", "DB_PASSWORD",
  "DB_DATABASE", "DIR_APPLICATION", "DIR_SYSTEM",
]);

function phpString(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function definedValues(content) {
  const values = {};
  const pattern = /define\s*\(\s*(['"])([A-Z][A-Z0-9_]*)\1\s*,\s*(['"])((?:\\.|(?!\3).)*)\3\s*\)\s*;/g;
  for (const match of content.matchAll(pattern)) {
    values[match[2]] = match[4].replace(/\\(['"\\])/g, "$1");
  }
  return values;
}

function replaceDefines(content, replacements) {
  let updated = content;
  for (const key of CONFIG_KEYS) {
    if (!Object.hasOwn(replacements, key)) continue;
    const pattern = new RegExp(`(define\\s*\\(\\s*(['"])${key}\\2\\s*,\\s*)(['"])(?:\\\\.|(?!\\3).)*\\3(\\s*\\)\\s*;)`);
    if (!pattern.test(updated)) {
      if (REQUIRED_KEYS.has(key)) throw new Error(`OpenCart configuration is missing ${key}`);
      continue;
    }
    updated = updated.replace(pattern, (match, prefix, quote, valueQuote, suffix) =>
      `${prefix}${phpString(replacements[key])}${suffix}`);
  }
  return updated;
}

function safeAdminDirectory(root, storefrontConfig) {
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(root, name, "config.php")))
    .filter((name) => {
      const values = definedValues(fs.readFileSync(path.join(root, name, "config.php"), "utf8"));
      return values.DIR_APPLICATION?.replaceAll("\\", "/").includes(`/${name}/`)
        || values.DIR_CATALOG
        || name.toLowerCase() === "admin";
    });
  const conventional = candidates.filter((name) => name.toLowerCase() === "admin");
  const selected = candidates.length === 1
    ? candidates[0]
    : conventional.length === 1 ? conventional[0] : "";
  if (!selected) {
    throw new Error(candidates.length
      ? "OpenCart archive contains multiple possible admin directories"
      : "OpenCart admin config.php was not found");
  }
  if (!storefrontConfig.DB_DATABASE) throw new Error("OpenCart storefront config.php is missing DB_DATABASE");
  return selected;
}

function inspectOpenCart(root) {
  const resolved = path.resolve(root);
  const storefrontPath = path.join(resolved, "config.php");
  if (!fs.existsSync(path.join(resolved, "index.php")) || !fs.existsSync(storefrontPath)) {
    throw new Error("OpenCart index.php and config.php were not found");
  }
  if (!fs.existsSync(path.join(resolved, "catalog")) || !fs.existsSync(path.join(resolved, "system"))) {
    throw new Error("OpenCart catalog and system directories were not found");
  }
  const storefront = definedValues(fs.readFileSync(storefrontPath, "utf8"));
  const adminDirectory = safeAdminDirectory(resolved, storefront);
  const adminPath = path.join(resolved, adminDirectory, "config.php");
  if (!fs.existsSync(path.join(resolved, adminDirectory, "index.php"))) {
    throw new Error("OpenCart admin index.php was not found");
  }
  const admin = definedValues(fs.readFileSync(adminPath, "utf8"));
  for (const key of ["DB_HOSTNAME", "DB_USERNAME", "DB_PASSWORD", "DB_DATABASE"]) {
    if (!storefront[key] || !admin[key]) throw new Error(`OpenCart configuration is missing ${key}`);
  }
  if (storefront.DB_DATABASE !== admin.DB_DATABASE) {
    throw new Error("OpenCart storefront and admin configurations use different databases");
  }
  return {
    root: resolved,
    adminDirectory,
    storefrontPath,
    adminPath,
    database: storefront.DB_DATABASE,
    databaseUser: storefront.DB_USERNAME,
  };
}

function directoryValues(root, applicationDirectory, adminDirectory = "") {
  const normalizedRoot = `${root.replace(/\/+$/, "")}/`;
  const storage = fs.existsSync(path.join(root, "storage"))
    ? `${normalizedRoot}storage/`
    : `${normalizedRoot}system/storage/`;
  const application = `${normalizedRoot}${applicationDirectory}/`;
  return {
    DIR_APPLICATION: application,
    DIR_SYSTEM: `${normalizedRoot}system/`,
    DIR_IMAGE: `${normalizedRoot}image/`,
    DIR_STORAGE: storage,
    DIR_LANGUAGE: `${application}language/`,
    DIR_TEMPLATE: adminDirectory
      ? `${application}view/template/`
      : `${application}view/theme/`,
    DIR_CONFIG: `${normalizedRoot}system/config/`,
    DIR_CACHE: `${storage}cache/`,
    DIR_DOWNLOAD: `${storage}download/`,
    DIR_LOGS: `${storage}logs/`,
    DIR_MODIFICATION: `${storage}modification/`,
    DIR_SESSION: `${storage}session/`,
    DIR_UPLOAD: `${storage}upload/`,
    ...(adminDirectory ? { DIR_CATALOG: `${normalizedRoot}catalog/` } : {}),
  };
}

function rewriteOpenCart(root, options) {
  const inspection = inspectOpenCart(root);
  const domain = String(options.domain || "").trim().toLowerCase();
  const scheme = options.useHttps ? "https" : "http";
  const containerRoot = String(options.containerRoot || "").replace(/\/+$/, "");
  if (!containerRoot.startsWith("/var/www/")) throw new Error("OpenCart container root is invalid");
  const database = options.database || {};
  const databaseValues = {
    DB_HOSTNAME: "hosting-db",
    DB_USERNAME: database.user,
    DB_PASSWORD: database.password,
    DB_DATABASE: database.name,
    DB_PORT: "3306",
  };
  const storefront = replaceDefines(fs.readFileSync(inspection.storefrontPath, "utf8"), {
    HTTP_SERVER: `${scheme}://${domain}/`,
    HTTPS_SERVER: `${scheme}://${domain}/`,
    ...databaseValues,
    ...directoryValues(containerRoot, "catalog"),
  });
  const admin = replaceDefines(fs.readFileSync(inspection.adminPath, "utf8"), {
    HTTP_SERVER: `${scheme}://${domain}/${inspection.adminDirectory}/`,
    HTTPS_SERVER: `${scheme}://${domain}/${inspection.adminDirectory}/`,
    HTTP_CATALOG: `${scheme}://${domain}/`,
    HTTPS_CATALOG: `${scheme}://${domain}/`,
    ...databaseValues,
    ...directoryValues(containerRoot, inspection.adminDirectory, inspection.adminDirectory),
  });
  fs.writeFileSync(inspection.storefrontPath, storefront, { encoding: "utf8", mode: 0o660 });
  fs.writeFileSync(inspection.adminPath, admin, { encoding: "utf8", mode: 0o660 });
  return { ...inspection, database: database.name, databaseUser: database.user };
}

module.exports = { definedValues, inspectOpenCart, replaceDefines, rewriteOpenCart };
