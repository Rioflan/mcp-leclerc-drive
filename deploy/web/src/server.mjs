// Serveur HTTP de l'interface : fichiers statiques + API JSON authentifiée.
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { safeEqual, verifyPassword } from "./auth.mjs";
import { BridgeError } from "./bridge-client.mjs";

const MAX_BODY = 8 * 1024;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' https://*.leclercdrive.fr",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

export async function loadStatic(dir) {
  const files = new Map();
  for (const name of await readdir(dir)) {
    const type = TYPES[extname(name)];
    if (type) files.set(`/${name}`, { body: await readFile(join(dir, name)), type });
  }
  return files;
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(415, "bad_request", "Content-Type application/json attendu.");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "bad_request", "Requête trop volumineuse.");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "bad_request", "JSON invalide.");
  }
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isProductId = (v) => typeof v === "string" && /^\d{1,12}$/.test(v);
const MAX_QUANTITY = 99;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createApp({ config, staticFiles, sessions, limiter, store, bridge, notifier, scheduler, log = console }) {
  const cookieName = config.secureCookie ? "__Host-sid" : "sid";

  function clientKey(req) {
    if (config.trustProxy) {
      const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function sessionCookie(id, maxAgeS) {
    const attrs = [`${cookieName}=${id}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeS}`];
    if (config.secureCookie) attrs.push("Secure");
    return attrs.join("; ");
  }

  function send(res, status, body, headers = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(data),
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(data);
  }

  function serveStatic(req, res, pathname) {
    const file = staticFiles.get(pathname === "/" ? "/index.html" : pathname);
    if (!file) return false;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": file.type,
      "Content-Length": file.body.length,
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : file.body);
    return true;
  }

  /** Session + CSRF : toute requête qui modifie doit porter le jeton de la session. */
  function requireSession(req) {
    const id = parseCookies(req.headers.cookie)[cookieName];
    const session = sessions.get(id);
    if (!session) throw new HttpError(401, "unauthorized", "Connexion requise.");
    if (req.method !== "GET" && req.method !== "HEAD") {
      const token = req.headers["x-csrf-token"];
      if (typeof token !== "string" || !safeEqual(token, session.csrf)) {
        throw new HttpError(403, "csrf", "Jeton CSRF invalide, recharge la page.");
      }
    }
    return { id, session };
  }

  /** Défense en profondeur avec SameSite : refuse les requêtes venues d'un autre site. */
  function checkOrigin(req) {
    if (req.method === "GET" || req.method === "HEAD") return;
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") {
      throw new HttpError(403, "cross_site", "Requête d'un autre site refusée.");
    }
  }

  const routes = {
    "POST /api/login": async (req, res) => {
      const key = clientKey(req);
      const wait = limiter.retryAfterMs(key);
      if (wait > 0) {
        throw Object.assign(new HttpError(429, "rate_limited", "Trop de tentatives, réessaie plus tard."), {
          retryAfter: Math.ceil(wait / 1000),
        });
      }
      const { password } = await readJson(req);
      if (!(await verifyPassword(password, config.passwordHash))) {
        limiter.fail(key);
        throw new HttpError(401, "bad_password", "Mot de passe incorrect.");
      }
      limiter.succeed(key);
      const s = sessions.create();
      return send(res, 200, { csrf: s.csrf }, { "Set-Cookie": sessionCookie(s.id, Math.floor(config.sessionTtlMs / 1000)) });
    },

    "POST /api/logout": async (req, res, { id }) => {
      sessions.destroy(id);
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
    },

    "GET /api/session": async (req, res, { session }) => send(res, 200, { csrf: session.csrf }),

    "GET /api/status": async () => {
      const store_ = await bridge.store().catch((err) => ({ error: err.message }));
      return {
        scheduler: scheduler.status(),
        store: store_.store ?? null,
        storeError: store_.error ?? null,
        ntfy: notifier.describe(),
        cartWrite: config.cartWrite,
        alerts: { total: store.alerts.length, armed: store.armed().length },
      };
    },

    "GET /api/cart": async () => bridge.cart(),

    "GET /api/search": async (req, res, ctx, url) => {
      const q = str(url.searchParams.get("q"), 100);
      if (q.length < 2) throw new HttpError(400, "bad_request", "Recherche trop courte (2 caractères minimum).");
      return bridge.search(q);
    },

    "GET /api/usual": async () => bridge.usual(),

    "GET /api/lists": async () => bridge.lists(),

    "GET /api/alerts": async () => ({ alerts: store.alerts }),

    "POST /api/alerts": async (req) => {
      const body = await readJson(req);
      const productId = str(body.productId, 12);
      const label = str(body.label, 200);
      const query = str(body.query, 100);
      if (!isProductId(productId) || !label) {
        throw new HttpError(400, "bad_request", "productId (chiffres) et label sont requis.");
      }
      return { alert: await store.upsert({ productId, label, query: query || label }) };
    },

    "POST /api/check": async () => ({ result: await scheduler.runNow(), scheduler: scheduler.status() }),

    "POST /api/store/detect": async () => bridge.detectStore(),

    "POST /api/notify/test": async () => {
      await notifier.send({
        title: "Test Leclerc Drive",
        message: "Les notifications fonctionnent.",
        tags: ["bell"],
        priority: 3,
      });
      return { ok: true };
    },
  };

  async function handleAlertItem(req, url) {
    const m = /^\/api\/alerts\/([^/]+)(\/rearm)?$/.exec(url.pathname);
    if (!m || !UUID_RE.test(m[1])) return undefined;
    if (req.method === "DELETE" && !m[2]) {
      if (!(await store.remove(m[1]))) throw new HttpError(404, "not_found", "Alerte introuvable.");
      return { ok: true };
    }
    if (req.method === "POST" && m[2]) {
      const alert = await store.rearm(m[1]);
      if (!alert) throw new HttpError(404, "not_found", "Alerte introuvable.");
      return { alert };
    }
    return undefined;
  }

  /** GET /api/lists/:id : produits d'une liste. */
  async function handleList(req, url) {
    const m = /^\/api\/lists\/([^/]+)$/.exec(url.pathname);
    if (!m || req.method !== "GET") return undefined;
    if (!isProductId(m[1])) throw new HttpError(400, "bad_request", "id de liste invalide.");
    return bridge.list(m[1]);
  }

  /** PUT /api/cart/items/:id { quantity } : quantité cible, 0 retire la ligne. */
  async function handleCartItem(req, url) {
    const m = /^\/api\/cart\/items\/([^/]+)$/.exec(url.pathname);
    if (!m || req.method !== "PUT") return undefined;
    if (!config.cartWrite) {
      throw new HttpError(403, "cart_write_disabled", "Modification du panier désactivée (CART_WRITE=false).");
    }
    const { quantity } = await readJson(req);
    if (!isProductId(m[1])) throw new HttpError(400, "bad_request", "id invalide.");
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
      throw new HttpError(400, "bad_request", `quantity : entier de 0 à ${MAX_QUANTITY}.`);
    }
    return bridge.setQuantity(m[1], quantity);
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

      if (!url.pathname.startsWith("/api/")) {
        if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res, url.pathname)) return;
        throw new HttpError(404, "not_found", "Introuvable.");
      }

      checkOrigin(req);
      const key = `${req.method} ${url.pathname}`;
      if (key === "POST /api/login") return await routes[key](req, res);

      const ctx = requireSession(req);
      if (routes[key]) {
        const out = await routes[key](req, res, ctx, url);
        if (!res.headersSent) send(res, 200, out);
        return;
      }
      const out =
        (await handleCartItem(req, url)) ?? (await handleList(req, url)) ?? (await handleAlertItem(req, url));
      if (out === undefined) throw new HttpError(404, "not_found", "Route inconnue.");
      send(res, 200, out);
    } catch (err) {
      const status = err instanceof HttpError || err instanceof BridgeError ? err.status : (err.status ?? 500);
      const code = status === 500 ? "internal" : (err.code ?? "error");
      if (status >= 500 && !(err instanceof BridgeError)) log.error(`${req.method} ${url.pathname} : ${err.stack || err}`);
      const message = status === 500 ? "Erreur interne." : err.message;
      const headers = err.retryAfter ? { "Retry-After": String(err.retryAfter) } : {};
      if (!res.headersSent) send(res, status, { error: code, message }, headers);
      else res.destroy();
    }
  };
}
