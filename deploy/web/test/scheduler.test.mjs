import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertStore } from "../src/store.mjs";
import { Scheduler } from "../src/scheduler.mjs";
import { fakeBridge, fakeNotifier } from "./helpers.mjs";

const silent = { error() {} };

async function setup(configOverrides = {}) {
  const store = await new AlertStore(await mkdtemp(join(tmpdir(), "sched-"))).load();
  const bridge = fakeBridge();
  const notifier = fakeNotifier();
  let t = Date.parse("2026-10-01T10:00:00Z");
  const clock = { advance: (ms) => (t += ms) };
  const config = {
    checkIntervalMs: 30 * 60_000,
    checkJitterMs: 10 * 60_000,
    failureThreshold: 3,
    notifySummary: false,
    publicUrl: "https://drive.example",
    ...configOverrides,
  };
  const scheduler = new Scheduler({ store, bridge, notifier, config, now: () => new Date(t), log: silent });
  return { store, bridge, notifier, scheduler, clock };
}

test("aucune alerte : aucune requête au site", async () => {
  const { scheduler, bridge } = await setup();
  assert.deepEqual(await scheduler.runOnce(), { checked: 0, triggered: 0 });
  assert.equal(bridge.calls, 0);
});

test("notifie une seule fois quand un produit redevient disponible", async () => {
  const { scheduler, store, bridge, notifier } = await setup();
  const a = await store.upsert({ productId: "16429", label: "Oeufs", query: "oeufs bio" });

  bridge.available.set("16429", false);
  await scheduler.runOnce();
  assert.equal(notifier.sent.length, 0);
  assert.equal(a.lastAvailable, false);
  assert.equal(a.status, "armed");

  bridge.available.set("16429", true);
  const r = await scheduler.runOnce();
  assert.equal(r.triggered, 1);
  assert.equal(notifier.sent.length, 1);
  assert.match(notifier.sent[0].message, /Produit 16429 — 2,50 €/);
  assert.equal(notifier.sent[0].click, "https://drive.example/#alertes");
  assert.equal(a.status, "triggered");

  await scheduler.runOnce();
  assert.equal(notifier.sent.length, 1, "alerte à usage unique");
});

test("produit introuvable : available null, pas de notification", async () => {
  const { scheduler, store, notifier } = await setup();
  const a = await store.upsert({ productId: "999", label: "Disparu", query: "disparu" });
  await scheduler.runOnce();
  assert.equal(a.lastAvailable, null);
  assert.equal(a.status, "armed");
  assert.equal(notifier.sent.length, 0);
});

test("échec de notification : l'alerte reste armée et l'erreur est visible", async () => {
  const { scheduler, store, bridge, notifier } = await setup();
  const a = await store.upsert({ productId: "1", label: "A", query: "a" });
  bridge.available.set("1", true);
  notifier.fail = true;
  await scheduler.runOnce();
  assert.equal(a.status, "armed");
  assert.match(store.scheduler.lastError, /ntfy en panne/);
  notifier.fail = false;
  await scheduler.runOnce();
  assert.equal(a.status, "triggered");
  assert.equal(store.scheduler.lastError, null);
});

test("alerte après N échecs d'affilée, une seule fois, puis rétablissement", async () => {
  const { scheduler, store, bridge, notifier } = await setup();
  await store.upsert({ productId: "1", label: "A", query: "a" });
  bridge.error = Object.assign(new Error("Session expirée"), { code: "session_expired" });

  await scheduler.runOnce();
  await scheduler.runOnce();
  assert.equal(notifier.sent.length, 0);
  await scheduler.runOnce();
  assert.equal(notifier.sent.length, 1);
  assert.match(notifier.sent[0].title, /Session Leclerc Drive expirée/);
  await scheduler.runOnce();
  assert.equal(notifier.sent.length, 1, "pas de répétition");
  assert.equal(store.scheduler.consecutiveFailures, 4);

  bridge.error = null;
  bridge.available.set("1", false);
  await scheduler.runOnce();
  assert.equal(notifier.sent.length, 2);
  assert.match(notifier.sent[1].title, /rétablie/);
  assert.equal(store.scheduler.consecutiveFailures, 0);
  assert.equal(store.scheduler.failureNotified, false);
});

test("pas de chevauchement : deux appels simultanés = une vérification", async () => {
  const { scheduler, store, bridge } = await setup();
  await store.upsert({ productId: "1", label: "A", query: "a" });
  await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
  assert.equal(bridge.calls, 1);
});

test("vérification manuelle limitée dans le temps", async () => {
  const { scheduler, store, clock } = await setup();
  await store.upsert({ productId: "1", label: "A", query: "a" });
  await scheduler.runNow();
  await assert.rejects(scheduler.runNow(), (err) => err.status === 429);
  clock.advance(3 * 60_000);
  await scheduler.runNow();
  scheduler.stop();
});

test("résumé des nouvelles ruptures du panier (option)", async () => {
  const { scheduler, bridge, notifier } = await setup({ notifySummary: true });
  bridge.cartOutOfStock = [{ id: "5", label: "Haricots" }];
  await scheduler.runOnce();
  assert.equal(notifier.sent.length, 1);
  assert.match(notifier.sent[0].message, /Haricots/);
  await scheduler.runOnce();
  assert.equal(notifier.sent.length, 1, "seules les nouvelles ruptures sont notifiées");
  bridge.cartOutOfStock = [{ id: "5", label: "Haricots" }, { id: "6", label: "Lentilles" }];
  await scheduler.runOnce();
  assert.equal(notifier.sent.length, 2);
  assert.doesNotMatch(notifier.sent[1].message, /Haricots/);
});

test("planification : prochain passage dans [intervalle, intervalle + aléa]", async () => {
  const { scheduler } = await setup();
  scheduler.random = () => 0.5;
  scheduler.start();
  const delta = Date.parse(scheduler.status().nextRunAt) - Date.parse("2026-10-01T10:00:00Z");
  assert.equal(delta, 30 * 60_000 + 5 * 60_000);
  scheduler.stop();
  assert.equal(scheduler.status().nextRunAt, null);
});
