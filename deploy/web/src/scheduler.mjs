// Vérification périodique des alertes : intervalle + aléa, pas de chevauchement,
// notification à chaque produit redevenu disponible et alerte en cas d'échecs
// répétés (session expirée, blocage anti-bot).
import { nextDelay } from "./duration.mjs";

export const MANUAL_MIN_GAP_MS = 2 * 60_000;

export class Scheduler {
  constructor({ store, bridge, notifier, config, random = Math.random, now = () => new Date(), log = console }) {
    Object.assign(this, { store, bridge, notifier, config, random, now, log });
    this.timer = null;
    this.running = null;
    this.nextRunAt = null;
  }

  start() {
    this.schedule();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  schedule() {
    clearTimeout(this.timer);
    const ms = nextDelay(this.config.checkIntervalMs, this.config.checkJitterMs, this.random);
    this.nextRunAt = new Date(this.now().getTime() + ms).toISOString();
    this.timer = setTimeout(() => {
      this.runOnce().finally(() => this.schedule());
    }, ms);
    this.timer.unref?.();
  }

  /** Vérification manuelle (bouton de l'UI), limitée pour ménager le site. */
  async runNow() {
    if (this.running) return this.running;
    const last = this.store.scheduler.lastRunAt;
    if (last && this.now().getTime() - Date.parse(last) < MANUAL_MIN_GAP_MS) {
      throw Object.assign(new Error("Vérification trop rapprochée, réessaie dans quelques minutes."), {
        status: 429,
        code: "rate_limited",
      });
    }
    try {
      return await this.runOnce();
    } finally {
      this.schedule();
    }
  }

  runOnce() {
    if (!this.running) {
      this.running = this.check().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  status() {
    const s = this.store.scheduler;
    return {
      running: Boolean(this.running),
      nextRunAt: this.nextRunAt,
      lastRunAt: s.lastRunAt,
      lastSuccessAt: s.lastSuccessAt,
      lastError: s.lastError,
      consecutiveFailures: s.consecutiveFailures,
      intervalMs: this.config.checkIntervalMs,
      jitterMs: this.config.checkJitterMs,
    };
  }

  async check() {
    const state = this.store.scheduler;
    const armed = this.store.armed();
    const at = this.now().toISOString();
    state.lastRunAt = at;

    // Rien à surveiller : aucune requête au site.
    if (armed.length === 0 && !this.config.notifySummary) {
      await this.store.save();
      return { checked: 0, triggered: 0 };
    }

    let result;
    try {
      if (armed.length > 0) {
        result = await this.bridge.availability(
          armed.map((a) => ({ id: a.productId, query: a.query || a.label })),
        );
      } else {
        const cart = await this.bridge.cart();
        result = {
          results: [],
          cartOutOfStock: cart.items.filter((i) => !i.available).map(({ id, label }) => ({ id, label })),
        };
      }
    } catch (err) {
      await this.onFailure(err);
      return { checked: 0, triggered: 0, error: err.message };
    }

    const { triggered, notifyError } = await this.applyResults(armed, result.results, at);
    await this.applyCartSummary(result.cartOutOfStock ?? []);
    await this.onSuccess(at, notifyError);
    return { checked: armed.length, triggered };
  }

  async applyResults(armed, results, at) {
    const byId = new Map(results.map((r) => [r.id, r]));
    let triggered = 0;
    let notifyError = null;
    for (const alert of armed) {
      const r = byId.get(alert.productId);
      if (!r) continue;
      alert.lastCheckedAt = at;
      alert.lastAvailable = r.available;
      if (r.available !== true) continue;
      try {
        await this.notify({
          title: "De nouveau disponible",
          message: `${r.label || alert.label}${typeof r.price === "number" ? ` — ${r.price.toFixed(2).replace(".", ",")} €` : ""}`,
          tags: ["shopping_cart", "white_check_mark"],
        });
        alert.status = "triggered";
        alert.triggeredAt = at;
        triggered++;
      } catch (err) {
        // L'alerte reste armée : la notification sera retentée au prochain passage.
        this.log.error(`notification échouée pour ${alert.productId} : ${err.message}`);
        notifyError = err.message;
      }
    }
    return { triggered, notifyError };
  }

  async applyCartSummary(outOfStock) {
    const state = this.store.scheduler;
    const previous = new Set(state.cartOutOfStock.map((i) => i.id));
    const fresh = outOfStock.filter((i) => !previous.has(i.id));
    state.cartOutOfStock = outOfStock;
    if (!this.config.notifySummary || fresh.length === 0) return;
    await this.notify({
      title: `${fresh.length} article(s) du panier en rupture`,
      message: fresh.map((i) => `• ${i.label}`).join("\n"),
      tags: ["warning"],
      priority: 3,
    }).catch((err) => this.log.error(`notification échouée : ${err.message}`));
  }

  async onFailure(err) {
    const state = this.store.scheduler;
    state.consecutiveFailures++;
    state.lastError = err.message;
    this.log.error(`vérification échouée (${state.consecutiveFailures}) : ${err.message}`);
    if (state.consecutiveFailures >= this.config.failureThreshold && !state.failureNotified) {
      const expired = err.code === "session_expired";
      try {
        await this.notify({
          title: expired ? "Session Leclerc Drive expirée" : "Vérification des stocks en échec",
          message:
            (expired
              ? "Reconnecte-toi à Leclerc Drive via le VNC du conteneur navigateur."
              : `${state.consecutiveFailures} vérifications d'affilée ont échoué : ${err.message}`) +
            "\nLes alertes ne sont plus vérifiées tant que ce n'est pas réglé.",
          tags: ["rotating_light"],
          priority: 5,
        });
        state.failureNotified = true;
      } catch (notifyErr) {
        this.log.error(`notification d'échec impossible : ${notifyErr.message}`);
      }
    }
    await this.store.save();
  }

  async onSuccess(at, notifyError = null) {
    const state = this.store.scheduler;
    if (state.failureNotified) {
      await this.notify({
        title: "Vérification des stocks rétablie",
        message: "Les alertes sont de nouveau vérifiées.",
        tags: ["ok"],
        priority: 3,
      }).catch((err) => this.log.error(`notification échouée : ${err.message}`));
    }
    Object.assign(state, {
      lastSuccessAt: at,
      lastError: notifyError,
      consecutiveFailures: 0,
      failureNotified: false,
    });
    await this.store.save();
  }

  notify(msg) {
    const click = this.config.publicUrl ? `${this.config.publicUrl}/#alertes` : undefined;
    return this.notifier.send({ ...msg, click });
  }
}
