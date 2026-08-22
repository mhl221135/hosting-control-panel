const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROLES = new Set(["standalone", "primary", "standby"]);

function configuredUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Peer health URL must be an HTTPS URL without credentials, query, or fragment");
  }
  return parsed.toString();
}

class PeerHealthStatus {
  constructor(options = {}) {
    this.url = configuredUrl(options.url);
    this.expectedServerId = String(options.expectedServerId || "").trim();
    this.token = String(options.token || "").trim();
    if (this.expectedServerId && !SERVER_ID.test(this.expectedServerId)) {
      throw new Error("Peer server ID is invalid");
    }
    this.fetch = options.fetch || global.fetch;
    this.now = options.now || Date.now;
    this.timeoutMs = Math.max(1000, Math.min(10_000, Number(options.timeoutMs || 5000)));
  }

  async read() {
    const checkedAt = new Date(this.now()).toISOString();
    if (!this.url || !this.expectedServerId || !this.token) {
      return { configured: false, reachable: false, identityMatched: false, checkedAt };
    }
    const started = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json", authorization: `Bearer ${this.token}` },
      });
      if (!response.ok) throw new Error(`Peer returned HTTP ${response.status}`);
      const body = await response.json();
      const serverId = SERVER_ID.test(String(body?.serverId || "")) ? String(body.serverId) : "";
      const role = ROLES.has(String(body?.role || "")) ? String(body.role) : "unknown";
      const identityMatched = serverId === this.expectedServerId;
      return {
        configured: true,
        reachable: body?.ok === true && identityMatched,
        authenticated: body?.ok === true,
        identityMatched,
        expectedServerId: this.expectedServerId,
        serverId,
        role,
        failoverStatus: String(body?.failoverStatus || "unknown").slice(0, 64),
        recoveryId: body?.recoveryId ? String(body.recoveryId).slice(0, 64) : null,
        latencyMs: Math.max(0, Math.round(this.now() - started)),
        checkedAt,
      };
    } catch (error) {
      return {
        configured: true,
        reachable: false,
        identityMatched: false,
        expectedServerId: this.expectedServerId,
        checkedAt,
        error: String(error?.name === "AbortError" ? "Peer health check timed out" : error?.message || error)
          .replace(/[\r\n\t\0]+/g, " ").slice(0, 160),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { PeerHealthStatus, configuredUrl };
