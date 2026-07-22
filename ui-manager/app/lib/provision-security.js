const PRESETS = new Set(["suspicious-probes", "xmlrpc-challenge", "login-rate-limit"]);
const WORDPRESS_ONLY = new Set(["xmlrpc-challenge", "login-rate-limit"]);

function selectedProvisionSecurity(body, siteType) {
  if (!body.apply_security_preset) return "";
  const preset = String(body.security_preset || "");
  if (!PRESETS.has(preset)) {
    throw Object.assign(new Error("Select a valid Cloudflare security preset"), { statusCode: 400 });
  }
  if (siteType !== "wordpress" && WORDPRESS_ONLY.has(preset)) {
    throw Object.assign(new Error("The selected Cloudflare security preset requires WordPress"), { statusCode: 400 });
  }
  return preset;
}

async function provisionSecurityStep(client, domain, preset) {
  if (!preset) return null;
  try {
    const result = await client.applySecurityPreset(domain, preset);
    return { name: "cloudflare-security", status: "complete", preset, created: Boolean(result.created) };
  } catch (error) {
    return { name: "cloudflare-security", status: "warning", preset, message: String(error.message || error) };
  }
}

module.exports = { PRESETS, WORDPRESS_ONLY, provisionSecurityStep, selectedProvisionSecurity };
