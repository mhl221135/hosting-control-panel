class EntitlementRefreshClient {
  constructor(options = {}) {
    this.url = options.url || process.env.ENTITLEMENT_REFRESH_API_URL || "";
    this.token = options.token || process.env.BILLING_API_TOKEN || "";
    this.fetch = options.fetch || global.fetch;
    this.retryDelaysMs = options.retryDelaysMs || [0, 5_000, 30_000];
    this.active = new Map();
  }

  configured() {
    return /^https?:\/\//.test(this.url) && this.token.length >= 32 && typeof this.fetch === "function";
  }

  trigger(deliveryId) {
    if (!this.configured()) return Promise.resolve({ ok: true, skipped: true });
    const key = String(deliveryId || "").slice(0, 160);
    if (this.active.has(key)) return this.active.get(key);
    const promise = this.run(key).finally(() => this.active.delete(key));
    this.active.set(key, promise);
    return promise;
  }

  async run(deliveryId) {
    let lastError;
    for (const delay of this.retryDelaysMs) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        return await this.send(deliveryId);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Entitlement refresh failed");
  }

  async send(deliveryId) {
    const response = await this.fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ delivery_id: deliveryId }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) {
      throw new Error(String(body.message || `Entitlement refresh API returned HTTP ${response.status}`).slice(0, 300));
    }
    return body;
  }
}

module.exports = { EntitlementRefreshClient };
