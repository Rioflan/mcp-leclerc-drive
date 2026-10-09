// Complète en tâche de fond les Nutri-Scores absents des listes : fiche produit
// Leclerc, puis Open Food Facts par code-barres. Une fiche à la fois, espacées
// de 10 à 20 s (en plus du throttle du client) pour rester discret vis-à-vis de
// l'anti-bot ; pause longue si le site bloque ou si la session a expiré.
import { resolveNutriScore } from "../dist/nutrition.js";

const MAX_QUEUE = 500;
const MAX_ATTEMPTS = 3;

export class NutriEnricher {
  constructor({ client, nutri, openFoodFacts, userAgent, minDelayMs = 10_000, jitterMs = 10_000, pauseMs = 15 * 60_000, log = console }) {
    Object.assign(this, { client, nutri, openFoodFacts, userAgent, minDelayMs, jitterMs, pauseMs, log });
    this.queue = new Set();
    this.attempts = new Map();
    this.running = false;
    this.stopped = false;
    this.resolved = 0;
    this.lastError = null;
  }

  /** Ajoute les produits sans Nutri-Score ni entrée de cache récente. */
  enqueue(products) {
    if (this.stopped) return;
    this.nutri.reload();
    for (const p of products) {
      if (this.queue.size >= MAX_QUEUE) break;
      if (this.nutri.needsLookup(p)) this.queue.add(p.id);
    }
    if (this.queue.size && !this.running) this.run();
  }

  status() {
    return { queued: this.queue.size, resolved: this.resolved, lastError: this.lastError };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  sleep(ms) {
    return new Promise((r) => (this.timer = setTimeout(r, ms)));
  }

  async run() {
    this.running = true;
    try {
      while (this.queue.size && !this.stopped) {
        await this.sleep(this.minDelayMs + Math.random() * this.jitterMs);
        const [id] = this.queue;
        if (this.nutri.get(id)) {
          this.queue.delete(id);
          continue;
        }
        try {
          await resolveNutriScore((pid) => this.client.getProductDetails(pid), this.nutri, id, {
            openFoodFacts: this.openFoodFacts,
            userAgent: this.userAgent,
          });
          this.queue.delete(id);
          this.attempts.delete(id);
          this.resolved++;
          this.lastError = null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.lastError = msg;
          if (/session .*expir|bloqu|datadome|HTTP 403|HTTP 429|chrome|cdp/i.test(msg)) {
            this.log.error(`nutri-score : pause de ${this.pauseMs / 60_000} min (${msg})`);
            await this.sleep(this.pauseMs);
          } else {
            // Erreur ponctuelle : nouvel essai en fin de file ; produit retiré du
            // magasin ou page inattendue : abandon après MAX_ATTEMPTS.
            const n = (this.attempts.get(id) ?? 0) + 1;
            this.queue.delete(id);
            if (n < MAX_ATTEMPTS) {
              this.attempts.set(id, n);
              this.queue.add(id);
            } else {
              this.attempts.delete(id);
            }
            this.log.error(`nutri-score : produit ${id}, essai ${n}/${MAX_ATTEMPTS} : ${msg}`);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
