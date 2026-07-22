function normalizeSiteType(value) {
  return String(value || "wordpress").trim().toLowerCase();
}

function supportsWordPressRedis(value) {
  return normalizeSiteType(value) === "wordpress";
}

module.exports = { normalizeSiteType, supportsWordPressRedis };
