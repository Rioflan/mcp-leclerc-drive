import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
import { baseEnv } from "./helpers.mjs";

test("configuration valide avec les valeurs par défaut", () => {
  const c = loadConfig(baseEnv());
  assert.equal(c.checkIntervalMs, 30 * 60_000);
  assert.equal(c.checkJitterMs, 10 * 60_000);
  assert.equal(c.ntfy.url, "https://ntfy.sh");
  assert.equal(c.failureThreshold, 3);
  assert.equal(c.secureCookie, false);
});

test("refuse un intervalle trop court sauf en mode dev", () => {
  assert.throws(() => loadConfig(baseEnv({ CHECK_INTERVAL: "5m" })), /au moins 10m/);
  const c = loadConfig(baseEnv({ CHECK_INTERVAL: "1m", DEV_ALLOW_SHORT_INTERVAL: "true" }));
  assert.equal(c.checkIntervalMs, 60_000);
});

test("refuse les secrets absents ou faibles et liste toutes les erreurs", () => {
  const err = (() => {
    try {
      loadConfig({ NTFY_TOPIC: "court", BRIDGE_TOKEN: "x" });
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err);
  assert.equal(err.errors.length, 3);
  assert.match(err.message, /UI_PASSWORD_HASH/);
  assert.match(err.message, /BRIDGE_TOKEN/);
  assert.match(err.message, /NTFY_TOPIC/);
});

test("valide NTFY_URL et les entiers", () => {
  assert.throws(() => loadConfig(baseEnv({ NTFY_URL: "ntfy.sh" })), /NTFY_URL/);
  assert.throws(() => loadConfig(baseEnv({ NTFY_URL: "https://ntfy.sh/topic" })), /NTFY_URL/);
  assert.throws(() => loadConfig(baseEnv({ FAILURE_THRESHOLD: "0" })), /FAILURE_THRESHOLD/);
  assert.throws(() => loadConfig(baseEnv({ CHECK_JITTER: "beaucoup" })), /Durée invalide/);
});
