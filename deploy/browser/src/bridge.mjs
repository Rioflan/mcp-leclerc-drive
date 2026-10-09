// Bridge HTTP interne : expose au conteneur web une API minimale. La seule
// écriture possible est la quantité d'une ligne du panier (jamais de commande ni
// de paiement), et elle se coupe avec CART_WRITE=false. Il n'est joignable que
// sur le réseau Docker interne et chaque requête doit porter BRIDGE_TOKEN.
import { createServer } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { createLeclerc, detectStore, readCart, toProduct } from "./leclerc.mjs";
import { NutriEnricher } from "./enricher.mjs";

const PORT = Number(process.env.BRIDGE_PORT || 8000);
const TOKEN = process.env.BRIDGE_TOKEN || "";
const MAX_BODY = 16 * 1024;
const MAX_ITEMS = 100;
const MAX_QUANTITY = 99;
const CART_WRITE = !["0", "false", "no", "off"].includes(String(process.env.CART_WRITE ?? "true").toLowerCase());

if (TOKEN.length < 32) {
  console.error("bridge: BRIDGE_TOKEN manquant ou trop court (32 caractères minimum).");
  process.exit(1);
}

const { config, browser, store, client, nutri } = createLeclerc();
const flag = (v, fallback) => (v === undefined || v === "" ? fallback : !["0", "false", "no", "off"].includes(v.toLowerCase()));
const enricher = flag(process.env.NUTRISCORE_ENRICH, true)
  ? new NutriEnricher({
      client,
      nutri,
      openFoodFacts: config.openFoodFacts,
      userAgent: "mcp-leclerc-drive-deploy (+https://github.com/skunkobi/mcp-leclerc-drive)",
    })
  : null;

/** Produits exposés : Nutri-Scores du cache, et les manquants partent en tâche de fond. */
function exposeProducts(products, { enrich = true } = {}) {
  nutri.reload();
  if (enrich) enricher?.enqueue(products);
  return products.map((p) => toProduct(nutri.apply(p)));
}

async function cartWithNutri() {
  const cart = await readCart(client, nutri);
  enricher?.enqueue(cart.items);
  return cart;
}
const tokenDigest = createHash("sha256").update(TOKEN).digest();

function authorized(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return false;
  return timingSafeEqual(createHash("sha256").update(m[1]).digest(), tokenDigest);
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Traduit les erreurs du client Leclerc en codes stables pour le conteneur web. */
function classify(err) {
  if (err instanceof HttpError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/session .*expir/i.test(msg)) return new HttpError(503, "session_expired", msg);
  if (/bloqu|datadome|HTTP 403|HTTP 429/i.test(msg)) return new HttpError(503, "blocked", msg);
  if (/chrome|cdp|navigateur/i.test(msg)) return new HttpError(503, "browser_unavailable", msg);
  return new HttpError(502, "upstream_error", msg);
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(415, "bad_request", "Content-Type application/json attendu.");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "bad_request", "Corps trop volumineux.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_request", "JSON invalide.");
  }
}

const isId = (v) => typeof v === "string" && /^\d{1,12}$/.test(v);
const cleanQuery = (v) => (typeof v === "string" ? v.trim().slice(0, 100) : "");

/**
 * Disponibilité d'une liste de produits : une lecture du panier, puis une
 * recherche par requête pour les produits absents du panier (les requêtes
 * identiques ne sont faites qu'une fois). Un produit introuvable renvoie
 * available: null (inconnu) plutôt que false.
 */
async function availability(items) {
  const cart = await cartWithNutri();
  const known = new Map(cart.items.map((i) => [i.id, i]));
  const searched = new Map();
  const results = [];
  for (const { id, query } of items) {
    let product = known.get(id);
    if (!product && query) {
      if (!searched.has(query)) {
        const found = await client.searchProducts(query);
        searched.set(query, found);
        for (const p of found) if (!known.has(p.id)) known.set(p.id, toProduct(p));
      }
      product = known.get(id);
    }
    results.push(
      product
        ? { id, found: true, available: product.available, label: product.label, price: product.price }
        : { id, found: false, available: null },
    );
  }
  const cartOutOfStock = cart.items
    .filter((i) => !i.available)
    .map(({ id, label }) => ({ id, label }));
  return { checkedAt: new Date().toISOString(), results, cartOutOfStock };
}

/**
 * Sans magasin choisi, le paquet retombe sur un magasin d'exemple qui n'est pas
 * celui de l'utilisateur. On tente donc de le détecter depuis le Chrome connecté
 * avant toute requête au site, et on refuse proprement sinon.
 */
async function ensureStore() {
  if (store.isPersisted) return;
  const detected = await detectStore(browser).catch(() => null);
  if (!detected) {
    throw new HttpError(
      409,
      "store_not_configured",
      "Aucun magasin configuré : connecte-toi à ton drive dans le VNC puis lance la détection.",
    );
  }
  store.set(detected);
}

async function route(req, url) {
  const { pathname } = url;
  const cartItem = /^\/cart\/items\/([^/]+)$/.exec(pathname);
  const list = /^\/lists\/([^/]+)$/.exec(pathname);
  if (["/cart", "/search", "/availability", "/usual", "/lists"].includes(pathname) || cartItem || list) await ensureStore();

  if (req.method === "GET" && pathname === "/cart") return cartWithNutri();

  if (req.method === "GET" && pathname === "/search") {
    const q = cleanQuery(url.searchParams.get("q"));
    if (q.length < 2) throw new HttpError(400, "bad_request", "Recherche trop courte.");
    // Recherche : cache appliqué, mais pas de tâche de fond (résultats éphémères, jusqu'à 200).
    const products = await client.searchProducts(q);
    return { query: q, products: exposeProducts(products, { enrich: false }) };
  }

  if (req.method === "POST" && pathname === "/availability") {
    const body = await readJson(req);
    const raw = Array.isArray(body?.items) ? body.items : null;
    if (!raw || raw.length === 0 || raw.length > MAX_ITEMS) {
      throw new HttpError(400, "bad_request", `items : 1 à ${MAX_ITEMS} éléments.`);
    }
    const items = raw.map((i) => ({ id: i?.id, query: cleanQuery(i?.query) }));
    if (!items.every((i) => isId(i.id))) throw new HttpError(400, "bad_request", "id invalide.");
    return availability(items);
  }

  if (req.method === "GET" && pathname === "/usual") {
    return { products: exposeProducts(await client.getUsualProducts()) };
  }

  if (req.method === "GET" && pathname === "/lists") {
    return { lists: await client.getLists() };
  }

  if (req.method === "GET" && list) {
    if (!isId(list[1])) throw new HttpError(400, "bad_request", "id de liste invalide.");
    return { id: list[1], products: exposeProducts(await client.getList(list[1])) };
  }

  if (req.method === "PUT" && cartItem) {
    if (!CART_WRITE) throw new HttpError(403, "cart_write_disabled", "Modification du panier désactivée (CART_WRITE=false).");
    const id = cartItem[1];
    const { quantity } = (await readJson(req)) ?? {};
    if (!isId(id)) throw new HttpError(400, "bad_request", "id invalide.");
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
      throw new HttpError(400, "bad_request", `quantity : entier de 0 à ${MAX_QUANTITY}.`);
    }
    // updateQuantity choisit le sens (ajout / retrait) et retire la ligne à 0.
    await client.updateQuantity(id, quantity);
    return cartWithNutri();
  }

  if (req.method === "GET" && pathname === "/store") {
    return { store: store.current(), nutriScore: enricher?.status() ?? null };
  }

  if (req.method === "POST" && pathname === "/store/detect") {
    const detected = await detectStore(browser);
    if (!detected) {
      throw new HttpError(
        404,
        "store_not_found",
        "Aucun onglet Leclerc Drive ouvert sur un magasin dans le Chrome du conteneur.",
      );
    }
    store.set(detected);
    return { store: store.current() };
  }

  throw new HttpError(404, "not_found", "Route inconnue.");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://bridge");
  // Sonde de vie locale : ne touche pas au site (pas de requête DataDome).
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true });
  }
  if (!authorized(req)) return send(res, 401, { error: "unauthorized", message: "Jeton invalide." });
  try {
    send(res, 200, await route(req, url));
  } catch (err) {
    const e = classify(err);
    if (e.status >= 500) console.error(`bridge: ${req.method} ${url.pathname} → ${e.code}: ${e.message}`);
    send(res, e.status, { error: e.code, message: e.message });
  }
});

// Une recherche peut enchaîner navigation + challenge DataDome + throttle.
server.requestTimeout = 10 * 60_000;
server.headersTimeout = 10_000;
server.listen(PORT, () => console.error(`bridge prêt sur :${PORT}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    server.close();
    enricher?.stop();
    await browser.close();
    process.exit(0);
  });
}
