/**
 * Runtime configuration, sourced from environment variables.
 *
 * Auth model (v0.3): requests run inside a real Chrome driven over CDP
 * (see src/browser.ts). Chrome opens with a persistent, dedicated profile; the
 * user logs into Leclerc Drive once in that window and the session persists.
 * This is what survives DataDome's active mode (which blocks headless /
 * cookie-replay clients). No cookies are read or stored.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface LeclercConfig {
  /** Default store id, e.g. "053701". Overridden at runtime by set_store. */
  storeId: string;
  /** Default backend host, e.g. "fd9-courses.leclercdrive.fr". */
  host: string;

  // --- Chrome / CDP ---
  /** Path to the Chrome binary; auto-detected per-OS when empty. */
  chromePath: string | undefined;
  /** Persistent Chrome profile dir (keeps the Leclerc login across restarts). */
  chromeProfileDir: string;
  /** CDP remote debugging port. */
  chromePort: number;
  /** Headless is detectable by DataDome — default false (a window opens). */
  headless: boolean;

  // --- Anti-strike (DataDome) throttling ---
  /** Minimum delay between two requests, in ms. */
  minIntervalMs: number;
  /** Extra random jitter added between requests, in ms. */
  jitterMs: number;
  /** Retries on a 403/429 before giving up. */
  maxRetries: number;
  /** Base backoff for retries, in ms (doubles each attempt). */
  backoffBaseMs: number;

  /** Look up missing Nutri-Scores on Open Food Facts by barcode (sends the EAN to OFF). */
  openFoodFacts: boolean;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

const DEFAULT_STORE_ID = "053701";
const DEFAULT_HOST = "fd9-courses.leclercdrive.fr";

export function loadConfig(): LeclercConfig {
  return {
    storeId: process.env.LECLERC_STORE_ID?.trim() || DEFAULT_STORE_ID,
    host: process.env.LECLERC_HOST?.trim() || DEFAULT_HOST,
    chromePath: process.env.LECLERC_CHROME_PATH?.trim() || undefined,
    chromeProfileDir:
      process.env.LECLERC_CHROME_PROFILE_DIR?.trim() ||
      join(homedir(), ".mcp-leclerc-drive", "chrome"),
    chromePort: intEnv("LECLERC_CHROME_PORT", 9222),
    headless: boolEnv("LECLERC_HEADLESS", false),
    minIntervalMs: intEnv("LECLERC_MIN_INTERVAL_MS", 1000),
    jitterMs: intEnv("LECLERC_JITTER_MS", 400),
    maxRetries: intEnv("LECLERC_MAX_RETRIES", 3),
    backoffBaseMs: intEnv("LECLERC_BACKOFF_BASE_MS", 1500),
    openFoodFacts: boolEnv("LECLERC_OPENFOODFACTS", true),
  };
}

/** Store path segment used by the backend (no cosmetic slug). */
export function storePath(storeId: string, noPR: string = storeId): string {
  // Leclerc store URLs embed the delivery point + retrieval point plus a slug,
  // e.g. /magasin-053701-053701-La-Ville-aux-Dames/. The slug is cosmetic; the
  // backend keys off the ids. For drives the two ids are equal; for piéton
  // relays they differ (noPL-noPR).
  return `magasin-${storeId}-${noPR}`;
}
