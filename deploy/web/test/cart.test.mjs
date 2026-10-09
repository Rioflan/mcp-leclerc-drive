import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { LoginLimiter, SessionStore } from "../src/auth.mjs";
import { AlertStore } from "../src/store.mjs";
import { Scheduler } from "../src/scheduler.mjs";
import { createApp } from "../src/server.mjs";
import { baseEnv, fakeBridge, fakeNotifier, PASSWORD } from "./helpers.mjs";

/** Serveur neuf connecté : renvoie un appelant authentifié et le bridge factice. */
async function startApp(env = {}) {
  const config = loadConfig(baseEnv(env));
  const store = await new AlertStore(await mkdtemp(join(tmpdir(), "cart-"))).load();
  const bridge = fakeBridge();
  const notifier = fakeNotifier();
  const server = createServer(
    createApp({
      config,
      staticFiles: new Map(),
      sessions: new SessionStore({ ttlMs: 60_000 }),
      limiter: new LoginLimiter(),
      store,
      bridge,
      notifier,
      scheduler: new Scheduler({ store, bridge, notifier, config, log: { error() {} } }),
      log: { error() {} },
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = async (method, path, { body, headers = {} } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { res, data: await res.json().catch(() => null) };
  };
  const l = await raw("POST", "/api/login", { body: { password: PASSWORD } });
  const cookie = l.res.headers.get("set-cookie").split(";")[0];
  const call = (method, path, { csrf = true, ...opts } = {}) =>
    raw(method, path, { ...opts, headers: { Cookie: cookie, ...(csrf ? { "X-CSRF-Token": l.data.csrf } : {}) } });
  return { call, bridge, close: () => server.close() };
}

test("produits habituels et listes relayés depuis le bridge", async () => {
  const app = await startApp();
  try {
    const usual = await app.call("GET", "/api/usual");
    assert.equal(usual.res.status, 200);
    assert.equal(usual.data.products[0].nutriScore, "B");
    assert.equal((await app.call("GET", "/api/lists")).data.lists[0].name, "Favoris");
    const list = await app.call("GET", "/api/lists/7");
    assert.equal(list.data.products[0].label, "Oeufs");
    assert.equal((await app.call("GET", "/api/lists/abc")).res.status, 400);
    assert.equal((await app.call("GET", "/api/lists/1/2")).res.status, 404);
  } finally {
    app.close();
  }
});

test("modification des quantités : validation, CSRF, retrait à 0", async () => {
  const app = await startApp();
  try {
    const status = await app.call("GET", "/api/status");
    assert.equal(status.data.cartWrite, true);

    assert.equal((await app.call("PUT", "/api/cart/items/42", { csrf: false, body: { quantity: 2 } })).res.status, 403, "sans CSRF");
    for (const quantity of [-1, 100, 1.5, "2", null]) {
      assert.equal((await app.call("PUT", "/api/cart/items/42", { body: { quantity } })).res.status, 400, `quantity ${quantity}`);
    }
    assert.equal((await app.call("PUT", "/api/cart/items/abc", { body: { quantity: 1 } })).res.status, 400, "id invalide");
    assert.equal((await app.call("POST", "/api/cart/items/42", { body: { quantity: 1 } })).res.status, 404, "méthode");

    const added = await app.call("PUT", "/api/cart/items/42", { body: { quantity: 2 } });
    assert.equal(added.res.status, 200);
    assert.deepEqual(added.data.items.map((i) => [i.id, i.quantity]), [["42", 2]]);

    const removed = await app.call("PUT", "/api/cart/items/42", { body: { quantity: 0 } });
    assert.equal(removed.data.items.length, 0);
  } finally {
    app.close();
  }
});

test("CART_WRITE=false : modification refusée, statut en lecture seule", async () => {
  const app = await startApp({ CART_WRITE: "false" });
  try {
    assert.equal((await app.call("GET", "/api/status")).data.cartWrite, false);
    const { res, data } = await app.call("PUT", "/api/cart/items/42", { body: { quantity: 1 } });
    assert.equal(res.status, 403);
    assert.equal(data.error, "cart_write_disabled");
    assert.equal(app.bridge.quantities.size, 0);
  } finally {
    app.close();
  }
});
