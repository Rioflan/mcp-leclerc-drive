// Accès partagé à Leclerc Drive pour le bridge et la CLI, en réutilisant le MCP
// compilé depuis la source du dépôt (/app/dist dans l'image).
import { loadConfig } from "../dist/config.js";
import { ChromeSession } from "../dist/browser.js";
import { parseStoreUrl, StoreState } from "../dist/store.js";
import { LeclercClient } from "../dist/leclerc/client.js";

export function createLeclerc() {
  const config = loadConfig();
  // Onglet dédié : l'onglet de l'utilisateur (VNC) et celui du serveur MCP ne
  // sont jamais navigués par le bridge, et inversement.
  const browser = new ChromeSession({
    chromePath: config.chromePath,
    profileDir: config.chromeProfileDir,
    port: config.chromePort,
    headless: config.headless,
    dedicatedTab: true,
  });
  const store = new StoreState(config);
  const client = new LeclercClient(config, browser, store);
  return { config, browser, store, client };
}

/** Ligne de panier / produit au format exposé (sans champ interne). */
export function toProduct(p) {
  return {
    id: p.id,
    label: p.label,
    price: p.price,
    pricePerUnit: p.pricePerUnit ?? null,
    available: p.available,
    imageUrl: p.imageUrl ?? null,
    nutriScore: p.nutriScore ?? null,
  };
}

export async function readCart(client) {
  const cart = await client.getCart();
  return {
    storeId: cart.storeId,
    total: cart.total,
    itemCount: cart.itemCount,
    items: cart.items.map((i) => ({
      ...toProduct(i.product),
      quantity: i.quantity,
      lineTotal: i.lineTotal,
    })),
  };
}

/**
 * Magasin de l'onglet Leclerc Drive ouvert dans Chrome (même logique que l'outil
 * MCP detect_store) : priorité aux URL qui portent le nom du magasin.
 */
export async function detectStore(browser) {
  const found = (await browser.pageUrls()).map(parseStoreUrl).filter(Boolean);
  return found.find((s) => s.name) ?? found[0] ?? null;
}
