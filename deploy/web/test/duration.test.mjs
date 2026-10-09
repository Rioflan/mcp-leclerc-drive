import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, nextDelay, parseDuration } from "../src/duration.mjs";

test("parseDuration accepte les formats courants", () => {
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration("1h30m"), 5_400_000);
  assert.equal(parseDuration(" 2H "), 7_200_000);
  assert.equal(parseDuration("0"), 0);
});

test("parseDuration refuse les valeurs invalides", () => {
  for (const bad of ["", "30", "m30", "30 m", "1h-5m", "abc", "10x"]) {
    assert.throws(() => parseDuration(bad), /Durée invalide/, bad);
  }
});

test("nextDelay reste dans [intervalle, intervalle + aléa]", () => {
  assert.equal(nextDelay(1000, 500, () => 0), 1000);
  assert.equal(nextDelay(1000, 500, () => 0.999999), 1500);
  assert.equal(nextDelay(1000, 0, Math.random), 1000);
  for (let i = 0; i < 1000; i++) {
    const d = nextDelay(1000, 500);
    assert.ok(d >= 1000 && d <= 1500);
  }
});

test("formatDuration", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(1_800_000), "30m");
  assert.equal(formatDuration(5_400_000), "1h30m");
  assert.equal(formatDuration(3_600_000), "1h");
});
