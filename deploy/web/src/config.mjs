// Configuration du service web, lue depuis l'environnement et validée au démarrage :
// une erreur de configuration doit empêcher le service de démarrer, pas le
// laisser tourner en silence sans jamais notifier.
import { parseDuration } from "./duration.mjs";
import { isPasswordHash } from "./auth.mjs";

const MIN_INTERVAL_MS = 10 * 60_000;

function bool(v, fallback = false) {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function int(name, v, fallback, min, max) {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} doit être un entier entre ${min} et ${max}.`);
  }
  return n;
}

export function loadConfig(env = process.env) {
  const errors = [];
  const check = (fn) => {
    try {
      return fn();
    } catch (err) {
      errors.push(err.message);
      return undefined;
    }
  };

  const allowShort = bool(env.DEV_ALLOW_SHORT_INTERVAL);
  const config = {
    port: check(() => int("PORT", env.PORT, 8080, 1, 65535)),
    dataDir: env.DATA_DIR || "/data",
    passwordHash: env.UI_PASSWORD_HASH || "",
    secureCookie: bool(env.UI_SECURE_COOKIE),
    sessionTtlMs: check(() => parseDuration(env.SESSION_TTL || "7d")),
    trustProxy: bool(env.TRUST_PROXY),
    publicUrl: (env.PUBLIC_URL || "").replace(/\/+$/, ""),
    bridgeUrl: (env.BRIDGE_URL || "http://browser:8000").replace(/\/+$/, ""),
    bridgeToken: env.BRIDGE_TOKEN || "",
    checkIntervalMs: check(() => parseDuration(env.CHECK_INTERVAL || "30m")),
    checkJitterMs: check(() => parseDuration(env.CHECK_JITTER || "10m")),
    failureThreshold: check(() => int("FAILURE_THRESHOLD", env.FAILURE_THRESHOLD, 3, 1, 100)),
    notifySummary: bool(env.NOTIFY_CART_OUT_OF_STOCK),
    cartWrite: bool(env.CART_WRITE, true),
    ntfy: {
      url: (env.NTFY_URL || "https://ntfy.sh").replace(/\/+$/, ""),
      topic: env.NTFY_TOPIC || "",
      token: env.NTFY_TOKEN || "",
      priority: check(() => int("NTFY_PRIORITY", env.NTFY_PRIORITY, 4, 1, 5)),
    },
  };

  if (!isPasswordHash(config.passwordHash)) {
    errors.push("UI_PASSWORD_HASH absent ou invalide (à générer avec hash-password, voir README).");
  }
  if (config.bridgeToken.length < 32) {
    errors.push("BRIDGE_TOKEN absent ou trop court (32 caractères minimum).");
  }
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(config.ntfy.topic)) {
    errors.push("NTFY_TOPIC doit faire 20 à 64 caractères [A-Za-z0-9_-] : il sert de mot de passe sur ntfy.sh.");
  }
  if (!/^https?:\/\/[^/]+$/.test(config.ntfy.url)) {
    errors.push("NTFY_URL doit être une URL http(s) sans chemin, ex. https://ntfy.sh.");
  }
  if (config.publicUrl && !/^https?:\/\/[^\s]+$/.test(config.publicUrl)) {
    errors.push("PUBLIC_URL doit être une URL http(s).");
  }
  if (config.checkIntervalMs !== undefined && config.checkIntervalMs < MIN_INTERVAL_MS && !allowShort) {
    errors.push("CHECK_INTERVAL doit être d'au moins 10m (protection anti-bot du site).");
  }

  if (errors.length) {
    const err = new Error(`Configuration invalide :\n- ${errors.join("\n- ")}`);
    err.errors = errors;
    throw err;
  }
  return config;
}
