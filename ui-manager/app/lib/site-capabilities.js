function normalizeSiteType(value) {
  const normalized = String(value || "wordpress").trim().toLowerCase();
  return ["wordpress", "static", "generic-php"].includes(normalized) ? normalized : "wordpress";
}

function supportsWordPressRedis(value) {
  return normalizeSiteType(value) === "wordpress";
}

const ADAPTERS = Object.freeze({
  wordpress: Object.freeze({
    type: "wordpress", label: "WordPress", database: "required",
    php: true, opcache: true, fastcgi: true, redis: true, imageOptimization: true,
  }),
  "generic-php": Object.freeze({
    type: "generic-php", label: "Generic PHP", database: "optional",
    php: true, opcache: true, fastcgi: true, redis: false, imageOptimization: false,
  }),
  static: Object.freeze({
    type: "static", label: "Static HTML", database: "none",
    php: false, opcache: false, fastcgi: false, redis: false, imageOptimization: false,
  }),
});

function siteAdapter(value) {
  return ADAPTERS[normalizeSiteType(value)];
}

function siteDatabaseReference(site) {
  const adapter = siteAdapter(site?.state?.siteType);
  if (adapter.database === "none") return null;
  const name = String(site?.state?.databaseName || "").trim();
  const user = String(site?.state?.databaseUser || name).trim();
  if (adapter.type === "generic-php" && !name) return null;
  return name ? { name, user } : null;
}

module.exports = { ADAPTERS, normalizeSiteType, siteAdapter, siteDatabaseReference, supportsWordPressRedis };
