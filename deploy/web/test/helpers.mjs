import { hashPassword } from "../src/auth.mjs";

export const TOPIC = "test_topic_0123456789abcdef";
export const BRIDGE_TOKEN = "b".repeat(40);
export const PASSWORD = "correct horse battery";
export const PASSWORD_HASH = await hashPassword(PASSWORD);

export function baseEnv(overrides = {}) {
  return {
    UI_PASSWORD_HASH: PASSWORD_HASH,
    BRIDGE_TOKEN,
    NTFY_TOPIC: TOPIC,
    ...overrides,
  };
}

/** Notifier factice qui garde les messages envoyés. */
export function fakeNotifier({ fail = false } = {}) {
  return {
    sent: [],
    fail,
    describe: () => "https://ntfy.sh/test…",
    async send(msg) {
      if (this.fail) throw new Error("ntfy en panne");
      this.sent.push(msg);
    },
  };
}

/** Bridge factice : disponibilités pilotées par le test. */
export function fakeBridge() {
  return {
    available: new Map(),
    cartOutOfStock: [],
    error: null,
    calls: 0,
    async availability(items) {
      this.calls++;
      if (this.error) throw this.error;
      return {
        results: items.map(({ id }) =>
          this.available.has(id)
            ? { id, found: true, available: this.available.get(id), label: `Produit ${id}`, price: 2.5 }
            : { id, found: false, available: null },
        ),
        cartOutOfStock: this.cartOutOfStock,
      };
    },
    async cart() {
      this.calls++;
      if (this.error) throw this.error;
      const items = this.cartOutOfStock.map((i) => ({ ...i, available: false, price: 1, quantity: 1, lineTotal: 1 }));
      return { items, total: items.length, itemCount: items.length };
    },
    quantities: new Map(),
    async usual() {
      return { products: [{ id: "42", label: "Habituel", price: 3, available: true, nutriScore: "B" }] };
    },
    async lists() {
      return { lists: [{ id: "7", name: "Favoris", productCount: 1 }] };
    },
    async list(id) {
      return { id, products: [{ id: "43", label: "Oeufs", price: 4, available: true, nutriScore: null }] };
    },
    async setQuantity(id, quantity) {
      if (quantity === 0) this.quantities.delete(id);
      else this.quantities.set(id, quantity);
      const items = [...this.quantities].map(([i, q]) => ({ id: i, label: `Produit ${i}`, available: true, price: 1, quantity: q, lineTotal: q }));
      return { items, total: items.reduce((s, i) => s + i.lineTotal, 0), itemCount: items.length };
    },
    async search(q) {
      return { query: q, products: [] };
    },
    async store() {
      return { store: { storeId: "123456", noPR: "123456", host: "fd1-courses.leclercdrive.fr", name: "Test" } };
    },
    async detectStore() {
      return this.store();
    },
  };
}
