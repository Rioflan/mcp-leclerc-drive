// Client du bridge du conteneur navigateur (réseau Docker interne, jeton partagé).

export class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

export class BridgeClient {
  constructor({ url, token }, { fetchImpl = fetch } = {}) {
    Object.assign(this, { url, token, fetchImpl });
  }

  async request(method, path, { body, timeoutMs = 120_000 } = {}) {
    const headers = { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BridgeError(503, "bridge_unreachable", `Conteneur navigateur injoignable : ${err.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new BridgeError(res.status, data.error || "bridge_error", data.message || `HTTP ${res.status}`);
    }
    return data;
  }

  cart() {
    return this.request("GET", "/cart");
  }

  search(q) {
    return this.request("GET", `/search?q=${encodeURIComponent(q)}`);
  }

  /** Une recherche par produit hors panier : on laisse du temps (throttle du site). */
  availability(items) {
    return this.request("POST", "/availability", {
      body: { items },
      timeoutMs: 60_000 + items.length * 15_000,
    });
  }

  store() {
    return this.request("GET", "/store");
  }

  detectStore() {
    return this.request("POST", "/store/detect");
  }
}
