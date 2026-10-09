// Durées lisibles ("90s", "30m", "1h30m") et calcul du délai avant la prochaine vérification.

const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (s === "0") return 0;
  const re = /(\d+)(ms|s|m|h|d)/g;
  let total = 0;
  let consumed = 0;
  for (const m of s.matchAll(re)) {
    if (m.index !== consumed) break;
    total += Number(m[1]) * UNITS[m[2]];
    consumed += m[0].length;
  }
  if (s.length === 0 || consumed !== s.length) {
    throw new Error(`Durée invalide : « ${input} » (exemples : 90s, 30m, 1h30m).`);
  }
  return total;
}

export function formatDuration(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return h ? `${h}h${m ? `${String(m).padStart(2, "0")}m` : ""}` : `${m}m`;
}

/** Intervalle + aléa uniforme dans [0, jitter], pour ne pas avoir une cadence fixe. */
export function nextDelay(intervalMs, jitterMs, random = Math.random) {
  return intervalMs + Math.floor(random() * (jitterMs + 1));
}
