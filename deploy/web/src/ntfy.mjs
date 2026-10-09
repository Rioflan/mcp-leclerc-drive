// Envoi de notifications ntfy (publication JSON : titre et message en UTF-8).

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class Ntfy {
  constructor({ url, topic, token, priority }, { fetchImpl = fetch, retries = 3, backoffMs = 2000 } = {}) {
    Object.assign(this, { url, topic, token, priority, fetchImpl, retries, backoffMs });
  }

  /** Sujet masqué pour l'affichage : il fait office de mot de passe sur ntfy.sh. */
  describe() {
    return `${this.url}/${this.topic.slice(0, 4)}…`;
  }

  async send({ title, message, tags = [], priority = this.priority, click }) {
    const body = { topic: this.topic, title, message, tags, priority };
    if (click) body.click = click;
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await delay(this.backoffMs * 2 ** (attempt - 1));
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return;
        lastError = new Error(`ntfy : HTTP ${res.status}`);
        // Erreur de configuration (sujet, jeton) : inutile d'insister.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch (err) {
        lastError = new Error(`ntfy : ${err.message}`);
      }
    }
    throw lastError;
  }
}
