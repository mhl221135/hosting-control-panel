import {
  boundedSeconds, canonicalReceipt, hmacHex, tokenMatches, validRecoveryId, validServerId,
} from "./protocol.js";

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const iso = (value) => new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");

async function body(request) {
  if ((request.headers.get("content-type") || "").split(";", 1)[0] !== "application/json") throw new Error("invalid-body");
  const text = await request.text();
  if (text.length > 2048) throw new Error("invalid-body");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-body");
  return value;
}

export class WitnessState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    let input;
    try { input = await body(request); } catch { return json({ error: "Invalid request" }, 400); }
    if (input.version !== 1 || !validServerId(input.primaryServerId)) return json({ error: "Invalid request" }, 400);
    const current = await this.state.storage.get("state") || {};
    const now = Date.now();

    if (url.pathname === "/lease") {
      if (current.primaryServerId && current.primaryServerId !== input.primaryServerId) {
        return json({ error: "Primary identity mismatch" }, 409);
      }
      if (current.fenced === true) return json({ error: "Primary is fenced" }, 409);
      const ttl = boundedSeconds(this.env.LEASE_TTL_SECONDS, 90, 60, 300);
      const next = {
        version: 1, primaryServerId: input.primaryServerId,
        leaseExpiresAt: iso(now + ttl * 1000), fenced: false,
      };
      await this.state.storage.put("state", next);
      return json({ version: 1, status: "leased", primaryServerId: input.primaryServerId,
        leaseExpiresAt: next.leaseExpiresAt });
    }

    if (url.pathname === "/fence") {
      if (!validRecoveryId(input.recoveryId)) return json({ error: "Invalid request" }, 400);
      if (current.primaryServerId && current.primaryServerId !== input.primaryServerId) {
        return json({ error: "Primary identity mismatch" }, 409);
      }
      const leaseExpires = Date.parse(current.leaseExpiresAt || "");
      if (Number.isFinite(leaseExpires) && leaseExpires > now) {
        return json({ error: "Primary lease is active", retryAfterSeconds: Math.ceil((leaseExpires - now) / 1000) }, 409);
      }
      if (current.lastRecoveryId && input.recoveryId <= current.lastRecoveryId) {
        return json({ error: "Recovery point is stale or already used" }, 409);
      }
      const ttl = boundedSeconds(this.env.RECEIPT_TTL_SECONDS, 600, 60, 900);
      const receipt = {
        version: 1, status: "fenced", primaryServerId: input.primaryServerId,
        recoveryId: input.recoveryId, method: "service",
        fencedAt: iso(now), expiresAt: iso(now + ttl * 1000),
        nonce: crypto.randomUUID().replaceAll("-", ""),
      };
      receipt.signature = await hmacHex(this.env.SIGNING_KEY, canonicalReceipt(receipt));
      await this.state.storage.put("state", { ...current, primaryServerId: input.primaryServerId,
        fenced: true, fencedAt: receipt.fencedAt, lastRecoveryId: input.recoveryId });
      return json(receipt);
    }

    if (url.pathname === "/reset") {
      if (input.confirm !== "RESET-FENCING-WITNESS") return json({ error: "Confirmation is required" }, 409);
      await this.state.storage.put("state", { version: 1, primaryServerId: input.primaryServerId,
        fenced: false, lastRecoveryId: current.lastRecoveryId || null });
      return json({ version: 1, status: "reset", primaryServerId: input.primaryServerId });
    }
    return json({ error: "Not found" }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "hosting-fencing-witness" });
    }
    const route = url.pathname;
    const auth = route === "/v1/lease" ? env.PRIMARY_TOKEN
      : route === "/v1/fence" ? env.STANDBY_TOKEN
        : route === "/v1/reset" ? env.ADMIN_TOKEN : null;
    if (request.method !== "POST" || !auth) return json({ error: "Not found" }, 404);
    if (!await tokenMatches(request, auth)) return json({ error: "Unauthorized" }, 401);
    const id = env.WITNESS_STATE.idFromName("hosting-primary");
    return env.WITNESS_STATE.get(id).fetch(new Request(`https://state${route.slice(3)}`, request));
  },
};
