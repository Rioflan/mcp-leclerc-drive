import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, isPasswordHash, LoginLimiter, SessionStore, verifyPassword } from "../src/auth.mjs";

test("hash et vérification du mot de passe", async () => {
  const h = await hashPassword("un mot de passe solide");
  assert.ok(isPasswordHash(h));
  assert.ok(!h.includes("$"), "pas de $ (interpolé par Docker Compose)");
  assert.equal(await verifyPassword("un mot de passe solide", h), true);
  assert.equal(await verifyPassword("un autre", h), false);
  assert.equal(await verifyPassword(undefined, h), false);
  assert.equal(await verifyPassword("x", "pas-un-hash"), false);
});

test("deux hash du même mot de passe diffèrent (sel)", async () => {
  assert.notEqual(await hashPassword("identique-123"), await hashPassword("identique-123"));
});

test("sessions : création, expiration, destruction", () => {
  let t = 0;
  const s = new SessionStore({ ttlMs: 1000, now: () => t });
  const a = s.create();
  assert.ok(s.get(a.id));
  assert.equal(s.get(a.id).csrf, a.csrf);
  t = 1000;
  assert.equal(s.get(a.id), null);
  const b = s.create();
  s.destroy(b.id);
  assert.equal(s.get(b.id), null);
  assert.equal(s.get(""), null);
  assert.equal(s.get(undefined), null);
});

test("limitation des tentatives de connexion", () => {
  let t = 0;
  const l = new LoginLimiter({ max: 3, windowMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) {
    assert.equal(l.retryAfterMs("ip"), 0);
    l.fail("ip");
  }
  assert.ok(l.retryAfterMs("ip") > 0);
  assert.equal(l.retryAfterMs("autre"), 0);
  t = 1000;
  assert.equal(l.retryAfterMs("ip"), 0);
  l.fail("ip");
  l.succeed("ip");
  assert.equal(l.retryAfterMs("ip"), 0);
});
