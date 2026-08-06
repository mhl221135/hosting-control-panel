const { annotateSiteAliases } = require("./runtime-config");

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function requireString(value, label, maximum) {
  if (typeof value !== "string") throw validationError(`${label} must be a string`);
  if (value.length > maximum) throw validationError(`${label} is too long`);
}

function optionalBoolean(body, key, label = key) {
  if (body[key] !== undefined && typeof body[key] !== "boolean") {
    throw validationError(`${label} must be a boolean`);
  }
}

function optionalInteger(body, key, label = key) {
  if (body[key] !== undefined && (typeof body[key] !== "number" || !Number.isInteger(body[key]))) {
    throw validationError(`${label} must be an integer`);
  }
}

function optionalString(body, key, label, maximum) {
  if (body[key] !== undefined) requireString(body[key], label, maximum);
}

function optionalStringArray(body, key, label, maximumCount, maximumLength) {
  if (body[key] === undefined) return;
  if (!Array.isArray(body[key])) throw validationError(`${label} must be an array`);
  if (body[key].length > maximumCount) throw validationError(`${label} has too many entries`);
  for (const value of body[key]) requireString(value, `${label} entry`, maximumLength);
}

function validateSiteStateMutation(body) {
  requireString(body.domain, "domain", 253);
  for (const key of [
    "fastcgi_cache", "redis", "opcache", "backup_enabled",
    "image_optimization_enabled", "maintenance_enabled",
  ]) optionalBoolean(body, key);
  optionalString(body, "notes", "notes", 2000);
  return body;
}

function validateCachePurgeMutation(body) {
  requireString(body.domain, "domain", 253);
  return body;
}

function validateImageSettingsMutation(body) {
  optionalBoolean(body, "enabled");
  optionalString(body, "schedule_time", "schedule_time", 5);
  return body;
}

function validateMaintenanceSettingsMutation(body) {
  optionalBoolean(body, "enabled");
  optionalInteger(body, "weekday");
  optionalInteger(body, "revision_retention");
  optionalString(body, "schedule_time", "schedule_time", 5);
  optionalStringArray(body, "operations", "operations", 5, 32);
  return body;
}

function validateUpdatePinsMutation(body) {
  requireString(body.domain, "domain", 253);
  optionalBoolean(body, "site");
  optionalBoolean(body, "core");
  optionalString(body, "note", "note", 300);
  optionalStringArray(body, "plugins", "plugins", 200, 160);
  optionalStringArray(body, "themes", "themes", 200, 160);
  optionalStringArray(body, "plugin_package_ids", "plugin_package_ids", 100, 50);
  optionalStringArray(body, "theme_package_ids", "theme_package_ids", 100, 50);
  return body;
}

function requirePrimarySite(mapParsed, domain, message = "Primary website is not configured") {
  const site = annotateSiteAliases(Object.values(mapParsed?.hosts || {}))
    .find((candidate) => candidate.host === domain);
  if (!site || site.isAlias) throw Object.assign(new Error(message), { statusCode: 404 });
  return site;
}

module.exports = {
  requirePrimarySite,
  validateCachePurgeMutation,
  validateImageSettingsMutation,
  validateMaintenanceSettingsMutation,
  validateSiteStateMutation,
  validateUpdatePinsMutation,
};
