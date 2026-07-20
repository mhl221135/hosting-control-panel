const path = require("path");

function resolvePublicFile(publicRoot, requestTarget) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestTarget, "http://localhost").pathname);
  } catch {
    return null;
  }

  const root = path.resolve(publicRoot);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

module.exports = { resolvePublicFile };
