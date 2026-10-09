import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { LoginLimiter, SessionStore } from "../src/auth.mjs";
import { AlertStore } from "../src/store.mjs";
import { Scheduler } from "../src/scheduler.mjs";
import { createApp, loadStatic } from "../src/server.mjs";
import { baseEnv, fakeBridge, fakeNotifier, PASSWORD } from "./helpers.mjs";

let server, base, notifier;

before(async () => {
  const config = loadConfig(baseEnv());
  const store = await new AlertStore(await mkdtemp(join(tmpdir(), "srv-"))).load();
  const bridge = fakeBridge();
  notifier = fakeNotifier();
  const scheduler = new Scheduler({ store, bridge, notifier, config, log: { error() {} } });
  const handler = createApp({
    config,
    staticFiles: await loadStatic(fileURLToPath(new URL("../public/", import.meta.url))),
    sessions: new SessionStore({ ttlMs: 60_000 }),
    limiter: new LoginLimiter({ max: 3, windowMs: 60_000 }),
    store,
    bridge,
    notifier,
    scheduler,
    log: { error() {} },
  });
  server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function req(method, path, { cookie, csrf, body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (csrf) h["X-CSRF-Token"] = csrf;
  let payload;
  if (body !== undefined) {
    h["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const data = await res.json().catch(() => null);
  return { res, data };
}

async function login(password = PASSWORD) {
  // X-Forwarded-For est ignoré sans TRUST_PROXY : il ne doit pas contourner la limitation.
  const headers = { "X-Forwarded-For": `10.0.0.${Math.floor(Math.random() * 250)}` };
  const { res, data } = await req("POST", "/api/login", { body: { password }, headers });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  return { res, data, cookie, csrf: data?.csrf };
}

test("pages statiques servies avec en-têtes de sécurité", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await fetch(base + "/../package.json")).status, 404);
  assert.equal((await fetch(base + "/inconnu.js")).status, 404);
});

test("healthz sans authentification", async () => {
  const { res } = await req("GET", "/healthz");
  assert.equal(res.status, 200);
});

test("API protégée sans session", async () => {
  for (const [m, p] of [["GET", "/api/alerts"], ["GET", "/api/cart"], ["POST", "/api/check"]]) {
    const { res } = await req(m, p, { body: m === "POST" ? {} : undefined });
    assert.equal(res.status, 401, `${m} ${p}`);
  }
});

test("connexion : cookie HttpOnly SameSite=Strict", async () => {
  const { res, csrf } = await login();
  assert.equal(res.status, 200);
  const sc = res.headers.get("set-cookie");
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.ok(csrf);
});

test("mauvais mot de passe puis limitation", async () => {
  // Sans TRUST_PROXY, X-Forwarded-For est ignoré : toutes les tentatives comptent pour 127.0.0.1.
  for (let i = 0; i < 3; i++) assert.equal((await login("mauvais")).res.status, 401);
  const blocked = await login(PASSWORD);
  assert.equal(blocked.res.status, 429);
  assert.ok(Number(blocked.res.headers.get("retry-after")) > 0);
});

test("parcours complet : alertes, CSRF, cross-site, suppression (serveur neuf, limiteur vierge)", async () => {
  const config = loadConfig(baseEnv());
  const store = await new AlertStore(await mkdtemp(join(tmpdir(), "srv2-"))).load();
  const n = fakeNotifier();
  const bridge = fakeBridge();
  const handler = createApp({
    config,
    staticFiles: new Map(),
    sessions: new SessionStore({ ttlMs: 60_000 }),
    limiter: new LoginLimiter(),
    store,
    bridge,
    notifier: n,
    scheduler: new Scheduler({ store, bridge, notifier: n, config, log: { error() {} } }),
    log: { error() {} },
  });
  const s2 = createServer(handler);
  await new Promise((r) => s2.listen(0, "127.0.0.1", r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const call = async (method, path, opts = {}) => {
    const headers = { ...(opts.headers ?? {}) };
    if (opts.cookie) headers.Cookie = opts.cookie;
    if (opts.csrf) headers["X-CSRF-Token"] = opts.csrf;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(b2 + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return { res, data: await res.json().catch(() => null) };
  };

  try {
    const l = await call("POST", "/api/login", { body: { password: PASSWORD } });
    const cookie = l.res.headers.get("set-cookie").split(";")[0];
    const csrf = l.data.csrf;

    const alert = { productId: "16429", label: "Oeufs <script>alert(1)</script>", query: "oeufs" };
    assert.equal((await call("POST", "/api/alerts", { cookie, body: alert })).res.status, 403, "sans CSRF");
    assert.equal(
      (await call("POST", "/api/alerts", { cookie, csrf: "faux", body: alert })).res.status,
      403,
      "mauvais CSRF",
    );
    assert.equal(
      (await call("POST", "/api/alerts", { cookie, csrf, body: alert, headers: { "Sec-Fetch-Site": "cross-site" } })).res
        .status,
      403,
      "cross-site",
    );
    assert.equal(
      (await call("POST", "/api/alerts", { cookie, csrf, body: { productId: "abc", label: "x" } })).res.status,
      400,
      "id invalide",
    );

    const created = await call("POST", "/api/alerts", { cookie, csrf, body: alert });
    assert.equal(created.res.status, 200);
    const id = created.data.alert.id;

    const list = await call("GET", "/api/alerts", { cookie });
    assert.equal(list.data.alerts.length, 1);

    assert.equal((await call("POST", `/api/alerts/${id}/rearm`, { cookie, csrf })).res.status, 200);
    assert.equal((await call("DELETE", `/api/alerts/${id}`, { cookie })).res.status, 403, "DELETE sans CSRF");
    assert.equal((await call("DELETE", `/api/alerts/${id}`, { cookie, csrf })).res.status, 200);
    assert.equal((await call("DELETE", `/api/alerts/${id}`, { cookie, csrf })).res.status, 404);
    assert.equal((await call("DELETE", "/api/alerts/../../etc", { cookie, csrf })).res.status, 404);

    const status = await call("GET", "/api/status", { cookie });
    assert.equal(status.data.store.name, "Test");
    assert.equal(status.data.ntfy, "https://ntfy.sh/test…");

    assert.equal((await call("GET", "/api/search?q=a", { cookie })).res.status, 400);
    assert.equal((await call("POST", "/api/notify/test", { cookie, csrf })).res.status, 200);
    assert.equal(n.sent.length, 1);

    const bad = await call("POST", "/api/alerts", {
      cookie,
      csrf,
      headers: { "Content-Type": "text/plain" },
    });
    assert.equal(bad.res.status, 415);

    assert.equal((await call("POST", "/api/logout", { cookie, csrf })).res.status, 200);
    assert.equal((await call("GET", "/api/alerts", { cookie })).res.status, 401, "session détruite");
  } finally {
    s2.close();
  }
});
