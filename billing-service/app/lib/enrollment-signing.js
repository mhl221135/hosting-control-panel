const crypto = require("crypto");

// Short-lived entitlement: the plugin should not cache for longer than this.
const ENTITLEMENT_TTL_MS = 300_000; // 5 minutes
const CONTRACT_VERSION = 1;

const ENTITLEMENT_FIELDS = new Set([
  "contract_version", "installation_id", "approved_canonical_domain",
  "entitlement_state", "issued_at", "expires_at", "renewal_url",
  "amount_minor", "currency", "renewal_months",
  "enforcement_enabled", "key_id",
]);

// Deterministic canonical serialization: sorted keys, no whitespace.
function canonicalizePayload(obj) {
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined || obj[key] === null) continue;
    sorted[key] = obj[key];
  }
  return JSON.stringify(sorted);
}

function buildEntitlementPayload({ installation, service, keyId, renewalUrl = "", now = new Date() }) {
  const allowedStates = new Set(["active", "reminder", "grace", "suspended", "exempt"]);
  const state = String(service?.hosting_state || "");
  const serviceMatches = Boolean(service && service.service_id === installation.service_id
    && service.primary_domain === installation.canonical_domain);
  // Missing, mismatched, or malformed billing data fails open. A valid
  // suspended state is represented accurately, but enforcement remains off
  // until the separately reviewed plugin phase enables it.
  const entitlementState = serviceMatches && allowedStates.has(state) ? state : "active";
  return {
    contract_version: CONTRACT_VERSION,
    installation_id: installation.installation_id,
    approved_canonical_domain: installation.canonical_domain,
    entitlement_state: entitlementState,
    issued_at: now.toISOString(),
    expires_at: new Date(now.valueOf() + ENTITLEMENT_TTL_MS).toISOString(),
    renewal_url: serviceMatches ? String(renewalUrl || "") : "",
    amount_minor: serviceMatches ? Number(service.hosting_price_minor || 0) : 0,
    currency: serviceMatches ? String(service.currency || "USD") : "USD",
    renewal_months: serviceMatches ? Number(service.renewal_months || 12) : 12,
    enforcement_enabled: false,
    key_id: keyId,
  };
}

function generateSigningKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
  };
}

function signPayload(privateKeyPem, payload) {
  const canonical = canonicalizePayload(payload);
  const signature = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKeyPem);
  return { canonical, signature: signature.toString("base64url") };
}

function verifySignature(publicKeyPem, canonical, signatureBase64url) {
  const sig = Buffer.from(signatureBase64url, "base64url");
  return crypto.verify(null, Buffer.from(canonical, "utf8"), publicKeyPem, sig);
}

function encryptPrivateKey(privateKeyPem, encryptionKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(privateKeyPem), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

function decryptPrivateKey(encryptedValue, encryptionKey) {
  if (!encryptedValue) return "";
  const [iv, tag, encrypted] = encryptedValue
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function loadEncryptionKey(settingsKey) {
  if (!settingsKey || settingsKey.length < 16) return null;
  return crypto.createHash("sha256").update(settingsKey).digest();
}

module.exports = {
  CONTRACT_VERSION,
  ENTITLEMENT_FIELDS,
  ENTITLEMENT_TTL_MS,
  buildEntitlementPayload,
  canonicalizePayload,
  decryptPrivateKey,
  encryptPrivateKey,
  generateSigningKey,
  loadEncryptionKey,
  signPayload,
  verifySignature,
};
