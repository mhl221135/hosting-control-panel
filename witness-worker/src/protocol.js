const RECOVERY_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function canonicalReceipt(value) {
  return [value.version, value.status, value.primaryServerId, value.recoveryId,
    value.method, value.fencedAt, value.expiresAt, value.nonce].join("|");
}

export function validServerId(value) {
  return typeof value === "string" && SERVER_ID.test(value);
}

export function validRecoveryId(value) {
  return typeof value === "string" && RECOVERY_ID.test(value);
}

export async function hmacHex(key, value) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const bytes = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function tokenMatches(request, expected) {
  const supplied = request.headers.get("authorization") || "";
  const wanted = `Bearer ${expected || ""}`;
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(wanted)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) difference |= a[index] ^ b[index];
  return Boolean(expected) && difference === 0;
}

export function boundedSeconds(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
