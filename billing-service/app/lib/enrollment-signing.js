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

function buildEntitlementPayload({ installation, service, keyId, publicBillingUrl }) {
  const now = new Date();
  const state = String(service?.hosting_state || "exempt");
  // Fail-open: if service data is missing or ambiguous, produce a safe
  // non-enforcing entitlement — never an accidental suspension.
  const safeState = state === "suspended" ? "active" : state;
// If no service data at all, default to the most permissive non-blocking state.
  const entitlementState = service
    ? (state === "suspended" ? "active" : state)
    : "active";
  return {
    contract_version: CONTRACT_VERSION,
    installation_id: installation.installation_id,
    approved_canonical_domain: installation.canonical_domain,
    entitlement_state: entitlementState,
    issued_at: now.toISOString(),
    expires_at: new Date(now.valueOf() + ENTITLEMENT_TTL_MS).toISOString(),
    renewal_url: publicBillingUrl
      && service
      ? `${publicBillingUrl}/renew/${service.renewalUrl || installation.service_id}`
      : "",
    amount_minor: Number(service?.hosting_price_minor || 0),
    currency: String(service?.currency || "USD"),
    renewal_months: Number(service?.renewal_months || 12),
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