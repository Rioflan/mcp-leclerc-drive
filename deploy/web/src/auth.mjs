// Mot de passe (scrypt), sessions en mémoire, jetons CSRF et limitation des
// tentatives de connexion. Format du hash : scrypt:N:r:p:sel:hash (base64url),
// sans « $ » pour ne pas être interprété par Docker Compose dans un .env.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEYLEN = 32;
const HASH_RE = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9_-]{16,}):([A-Za-z0-9_-]{40,})$/;

const maxmem = (N, r) => 256 * N * r;

export function isPasswordHash(s) {
  return typeof s === "string" && HASH_RE.test(s);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p } = PARAMS;
  const key = await scrypt(password, salt, KEYLEN, { N, r, p, maxmem: maxmem(N, r) });
  return `scrypt:${N}:${r}:${p}:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

export async function verifyPassword(password, stored) {
  const m = HASH_RE.exec(stored);
  if (!m || typeof password !== "string" || password.length > 1024) return false;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const expected = Buffer.from(m[5], "base64url");
  const key = await scrypt(password, Buffer.from(m[4], "base64url"), expected.length, {
    N,
    r,
    p,
    maxmem: maxmem(N, r),
  });
  return timingSafeEqual(key, expected);
}

export function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** Sessions côté serveur : un redémarrage déconnecte, ce qui est voulu. */
export class SessionStore {
  constructor({ ttlMs, now = Date.now }) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
  }

  create() {
    this.sweep();
    const id = randomBytes(32).toString("base64url");
    const session = { csrf: randomBytes(32).toString("base64url"), expiresAt: this.now() + this.ttlMs };
    this.sessions.set(id, session);
    return { id, ...session };
  }

  get(id) {
    if (typeof id !== "string" || !id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  destroy(id) {
    this.sessions.delete(id);
  }

  sweep() {
    const t = this.now();
    for (const [id, s] of this.sessions) if (s.expiresAt <= t) this.sessions.delete(id);
  }
}

/**
 * Limite les échecs de connexion par client : au-delà de `max` échecs dans la
 * fenêtre, les tentatives sont refusées jusqu'à expiration de la fenêtre.
 */
export class LoginLimiter {
  constructor({ max = 5, windowMs = 15 * 60_000, now = Date.now } = {}) {
    Object.assign(this, { max, windowMs, now });
    this.failures = new Map();
  }

  retryAfterMs(key) {
    const f = this.failures.get(key);
    if (!f) return 0;
    const left = f.since + this.windowMs - this.now();
    if (left <= 0) {
      this.failures.delete(key);
      return 0;
    }
    return f.count >= this.max ? left : 0;
  }

  fail(key) {
    const t = this.now();
    const f = this.failures.get(key);
    if (!f || f.since + this.windowMs <= t) this.failures.set(key, { count: 1, since: t });
    else f.count++;
  }

  succeed(key) {
    this.failures.delete(key);
  }
}
