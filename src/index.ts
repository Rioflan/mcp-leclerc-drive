#!/usr/bin/env node
/**
 * MCP server for E.Leclerc Drive.
 *
 * Exposes search / cart tools over stdio so Claude Desktop, Claude Code, or any
 * MCP client can drive grocery ordering natively instead of via browser
 * automation.
 *
 * The tool *contracts* are final; the underlying client (src/leclerc/client.ts)
 * still needs its endpoints wired up from a network capture — until then tools
 * return a clear "not reverse-engineered yet" error.
 */

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ChromeSession } from "./browser.js";
import { loadConfig } from "./config.js";
import { LeclercClient } from "./leclerc/client.js";
import { FoundStore, StoreLocator } from "./leclerc/locator.js";
import { NutriCache, resolveNutriScore } from "./nutrition.js";
import { parseStoreUrl, StoreState, validateStore } from "./store.js";
import { Cart, Product } from "./types.js";

// Single source of truth for the version: read it from package.json (one dir up
// from dist/index.js) so serverInfo never drifts from the published package.
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const config = loadConfig();
const browser = new ChromeSession({
  chromePath: config.chromePath,
  profileDir: config.chromeProfileDir,
  port: config.chromePort,
  headless: config.headless,
});
const store = new StoreState(config);
const client = new LeclercClient(config, browser, store);
const locator = new StoreLocator(config, browser);
const nutri = new NutriCache();
const userAgent = `mcp-leclerc-drive/${pkg.version} (+https://github.com/skunkobi/mcp-leclerc-drive)`;

/** Fill missing Nutri-Scores from the cache (written by get_product and the deploy bridge). */
function withCachedNutri(products: Product[]): Product[] {
  nutri.reload();
  return products.map((p) => nutri.apply(p));
}
function cartWithCachedNutri(cart: Cart): Cart {
  nutri.reload();
  return { ...cart, items: cart.items.map((it) => ({ ...it, product: nutri.apply(it.product) })) };
}
const nutriLabel = (p: Product) =>
  p.nutriScore ? `Nutri-Score ${p.nutriScore}${p.nutriScoreSource === "openfoodfacts" ? " (Open Food Facts)" : ""}` : null;

// Cache of the last find_stores results, so set_store can resolve the host
// (and noPR) from just a store id the user picked.
const lastFound = new Map<string, FoundStore>();

const server = new McpServer({
  name: "mcp-leclerc-drive",
  version: pkg.version,
});

function formatProduct(p: Product): string {
  const bits = [
    p.label,
    p.brand ? `(${p.brand})` : null,
    `— ${p.price.toFixed(2)} €`,
    p.pricePerUnit ? `[${p.pricePerUnit}]` : null,
    nutriLabel(p),
    p.available ? null : "⚠️ indisponible",
    `id=${p.id}`,
  ].filter(Boolean);
  return bits.join(" ");
}

function formatCart(cart: Cart): string {
  if (cart.items.length === 0) return "Panier vide.";
  const lines = cart.items.map(
    (it) =>
      `• ${it.quantity}× ${it.product.label} — ${it.lineTotal.toFixed(2)} € ` +
      `${it.product.nutriScore ? `${nutriLabel(it.product)} ` : ""}` +
      `${it.product.available ? "" : "⚠️ indisponible "}(id=${it.product.id})`,
  );
  const unavailable = cart.items.filter((it) => !it.product.available).length;
  return (
    `Panier (magasin ${cart.storeId}) — ${cart.itemCount} article(s) :\n` +
    lines.join("\n") +
    `\n\nTotal : ${cart.total.toFixed(2)} €` +
    (unavailable ? `\n⚠️ ${unavailable} référence(s) indisponible(s) dans le panier.` : "")
  );
}

/** Wrap a tool body so thrown errors become structured MCP error content. */
function asText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function asError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Erreur : ${message}` }], isError: true };
}

server.tool(
  "search_product",
  "Recherche des produits dans le catalogue Leclerc Drive du magasin configuré. " +
    "Retourne label, prix, prix au kilo/litre, Nutri-Score, disponibilité et l'id " +
    "à utiliser pour add_to_cart.",
  { query: z.string().describe("Termes de recherche, ex. 'lait demi-écrémé bio'") },
  async ({ query }) => {
    try {
      const products = withCachedNutri(await client.searchProducts(query));
      if (products.length === 0) return asText(`Aucun produit trouvé pour « ${query} ».`);
      return asText(products.map(formatProduct).join("\n"));
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "add_to_cart",
  "Ajoute un produit au panier. Utilise l'id retourné par search_product.",
  {
    product_id: z.string().describe("Identifiant produit (champ id de search_product)"),
    quantity: z.number().int().positive().default(1).describe("Quantité à ajouter"),
  },
  async ({ product_id, quantity }) => {
    try {
      const cart = await client.addToCart(product_id, quantity);
      return asText(`Ajouté.\n\n${formatCart(cartWithCachedNutri(cart))}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "remove_from_cart",
  "Retire complètement un produit du panier.",
  { product_id: z.string().describe("Identifiant produit à retirer") },
  async ({ product_id }) => {
    try {
      const cart = await client.removeFromCart(product_id);
      return asText(`Retiré.\n\n${formatCart(cartWithCachedNutri(cart))}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "update_quantity",
  "Modifie la quantité d'un produit déjà présent dans le panier.",
  {
    product_id: z.string().describe("Identifiant produit"),
    quantity: z.number().int().nonnegative().describe("Nouvelle quantité (0 pour retirer)"),
  },
  async ({ product_id, quantity }) => {
    try {
      const cart = await client.updateQuantity(product_id, quantity);
      return asText(`Quantité mise à jour.\n\n${formatCart(cartWithCachedNutri(cart))}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "get_cart",
  "Affiche le contenu complet du panier avec le total et signale les articles indisponibles (rupture de stock).",
  {},
  async () => {
    try {
      const cart = cartWithCachedNutri(await client.getCart());
      return asText(formatCart(cart));
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "get_usual_products",
  "Liste les produits habituels du compte (« Mes produits habituels » sur Leclerc Drive : " +
    "ce qu'il commande souvent) avec prix, Nutri-Score, disponibilité et l'id pour add_to_cart.",
  {},
  async () => {
    try {
      const products = withCachedNutri(await client.getUsualProducts());
      if (products.length === 0) {
        return asText(
          "Aucun produit habituel : le compte doit être connecté dans Chrome et avoir déjà commandé en drive.",
        );
      }
      return asText(`${products.length} produit(s) habituel(s) :\n${products.map(formatProduct).join("\n")}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "get_lists",
  "Liste les listes de courses du compte (« Mes listes », ex. une liste « Favoris ») " +
    "avec leur id à passer à get_list.",
  {},
  async () => {
    try {
      const lists = await client.getLists();
      if (lists.length === 0) return asText("Aucune liste sur le compte.");
      return asText(
        lists
          .map((l) => `• ${l.name}${l.productCount === undefined ? "" : ` (${l.productCount} produit(s))`} list_id=${l.id}`)
          .join("\n"),
      );
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "get_list",
  "Affiche les produits d'une liste de courses (id donné par get_lists) avec prix, " +
    "Nutri-Score, disponibilité et l'id pour add_to_cart.",
  { list_id: z.string().regex(/^\d{1,12}$/).describe("Identifiant de la liste (champ list_id de get_lists)") },
  async ({ list_id }) => {
    try {
      const products = withCachedNutri(await client.getList(list_id));
      if (products.length === 0) return asText("Liste vide.");
      return asText(`${products.length} produit(s) :\n${products.map(formatProduct).join("\n")}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "get_product",
  "Fiche d'un produit : code-barres (EAN), marque, origine, disponibilité, Nutri-Score " +
    "(page Leclerc, sinon Open Food Facts) et valeurs nutritionnelles Open Food Facts. " +
    "Une requête au site par appel : à utiliser pour quelques produits, pas en masse.",
  { product_id: z.string().regex(/^\d{1,12}$/).describe("Identifiant produit (champ id)") },
  async ({ product_id }) => {
    try {
      const { details, entry, off } = await resolveNutriScore(
        (id) => client.getProductDetails(id),
        nutri,
        product_id,
        { openFoodFacts: config.openFoodFacts, userAgent, alwaysOpenFoodFacts: true },
      );
      const p = details.product;
      const lines = [
        formatProduct(nutri.apply(p)),
        details.brand ? `Marque : ${details.brand}` : null,
        details.origin ? `Origine : ${details.origin}` : null,
        details.ean ? `EAN : ${details.ean}` : "EAN : non communiqué par Leclerc",
        entry.grade
          ? null
          : "Nutri-Score : aucun (produit frais ou non concerné, ou inconnu d'Open Food Facts)",
      ];
      if (off) {
        const n = off.nutriments;
        const facts = [
          n.energyKcal !== undefined ? `${n.energyKcal} kcal` : null,
          n.fat !== undefined ? `matières grasses ${n.fat} g` : null,
          n.saturatedFat !== undefined ? `dont saturées ${n.saturatedFat} g` : null,
          n.sugars !== undefined ? `sucres ${n.sugars} g` : null,
          n.salt !== undefined ? `sel ${n.salt} g` : null,
          n.proteins !== undefined ? `protéines ${n.proteins} g` : null,
          n.fiber !== undefined ? `fibres ${n.fiber} g` : null,
        ].filter(Boolean);
        lines.push(
          `Open Food Facts : ${off.name ?? "?"}${off.nutriScore ? `, Nutri-Score ${off.nutriScore}` : ""}` +
            `${off.novaGroup ? `, NOVA ${off.novaGroup}` : ""} — ${off.url}`,
        );
        if (facts.length) lines.push(`Pour 100 g : ${facts.join(", ")}`);
      } else if (details.ean && config.openFoodFacts) {
        lines.push("Open Food Facts : produit inconnu.");
      }
      return asText(lines.filter(Boolean).join("\n"));
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "find_stores",
  "Recherche les drives E.Leclerc proches d'un code postal ou d'une ville, triés " +
    "par distance. Retourne pour chacun : nom, identifiant (à passer à set_store), " +
    "type de service (drive/relais/livraison), distance et magasin.",
  { query: z.string().describe("Code postal ou ville, ex. '44000' ou 'Nantes'") },
  async ({ query }) => {
    try {
      const stores = await locator.findStores(query);
      if (stores.length === 0) return asText(`Aucun drive trouvé pour « ${query} ».`);
      lastFound.clear();
      for (const s of stores) lastFound.set(s.storeId, s);
      const lines = stores.map((s) => {
        const dist = s.distanceKm !== undefined ? `${s.distanceKm.toFixed(1)} km` : "";
        return `• ${s.name} — ${s.serviceType} ${dist} (id=${s.storeId})`;
      });
      return asText(
        `Drives autour de « ${query} » :\n${lines.join("\n")}\n\n` +
          `Pour en choisir un : set_store avec son id. Les courses fonctionnent sur les « drive ».`,
      );
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "set_store",
  "Sélectionne le magasin actif (et le mémorise pour les prochaines sessions). " +
    "Utilise l'id renvoyé par find_stores.",
  {
    store_id: z.string().describe("Identifiant magasin (champ id de find_stores)"),
    host: z
      .string()
      .optional()
      .describe("Host backend (optionnel) si le magasin n'a pas été trouvé via find_stores"),
    no_pr: z
      .string()
      .optional()
      .describe(
        "Point de retrait (optionnel, avec host) : 2e numéro de l'URL magasin-<id>-<noPR>, " +
          "différent de l'id pour les points de retrait piéton",
      ),
  },
  async ({ store_id, host, no_pr }) => {
    try {
      const found = lastFound.get(store_id);
      if (!found && !host) {
        return asError(
          new Error(
            `Magasin ${store_id} inconnu. Lance d'abord find_stores, puis set_store avec un id ` +
              `de la liste (ou fournis le paramètre host).`,
          ),
        );
      }
      const selection = found
        ? { storeId: found.storeId, noPR: found.noPR, host: found.host, name: found.name }
        : { storeId: store_id, noPR: no_pr ?? store_id, host: host as string };
      // Saisie manuelle uniquement : les résultats de find_stores viennent de l'API Leclerc.
      const invalid = found ? null : validateStore(selection.storeId, selection.noPR, selection.host);
      if (invalid) return asError(new Error(invalid));
      store.set(selection);
      return asText(
        `Magasin actif : ${selection.name ?? selection.storeId} ` +
          `(id=${selection.storeId} @ ${selection.host}). Mémorisé.`,
      );
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "detect_store",
  "Détecte le magasin depuis l'onglet Leclerc Drive ouvert dans le Chrome du serveur " +
    "(celui où l'utilisateur est connecté) et le sélectionne. Gère les points de retrait.",
  {},
  async () => {
    try {
      const urls = await browser.pageUrls();
      // Priorité aux URL avec le nom du magasin (onglet de l'utilisateur) plutôt
      // qu'aux pages techniques ouvertes par le serveur, qui n'en ont pas.
      const found = urls.map(parseStoreUrl).filter((s) => s !== null);
      const detected = found.find((s) => s.name) ?? found[0];
      if (!detected) {
        return asError(
          new Error(
            "Aucun onglet ouvert sur une page magasin Leclerc Drive. Ouvre ton drive dans la " +
              "fenêtre Chrome du serveur (URL contenant /magasin-…), puis réessaie.",
          ),
        );
      }
      store.set(detected);
      return asText(
        `Magasin actif : ${detected.name ?? detected.storeId} ` +
          `(id=${detected.storeId}, retrait=${detected.noPR} @ ${detected.host}). Mémorisé.`,
      );
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "get_store",
  "Affiche le magasin actuellement sélectionné (id, host).",
  {},
  async () => {
    const s = store.current();
    return asText(`Magasin actif : ${s.name ?? s.storeId} (id=${s.storeId} @ ${s.host}).`);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const s = store.current();
  // stderr only — stdout is the MCP channel.
  console.error(
    `mcp-leclerc-drive ready (store ${s.storeId} @ ${s.host}, ` +
      `auth: real Chrome via CDP${config.headless ? " [headless]" : ""})`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
