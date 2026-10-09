/**
 * Active store selection, with cross-session persistence.
 *
 * The store the tools operate on can be chosen at runtime (set_store) instead of
 * being fixed by env vars. The choice is persisted to
 * `~/.mcp-leclerc-drive/config.json` so it survives restarts. Resolution order:
 * persisted file → env/defaults (LeclercConfig).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { LeclercConfig } from "./config.js";

export interface StoreSelection {
  /** Canonical store number (noPL), e.g. "053701". Used in URLs and payloads. */
  storeId: string;
  /** Retrieval point (noPR); equals storeId for drives, differs for piéton relays. */
  noPR: string;
  /** Backend host, e.g. "fd9-courses.leclercdrive.fr" (the fdN prefix varies). */
  host: string;
  /** Human-readable name, e.g. "Rezé Atout Sud" (optional, for display). */
  name?: string;
}

const STORE_ID_RE = /^\d{6}$/;
const HOST_RE = /^fd\d+-courses\.leclercdrive\.fr$/;
const STORE_URL_RE =
  /^https:\/\/(fd\d+-courses\.leclercdrive\.fr)\/magasin-(\d{6})-(\d{6})(?:-([^/?#]+))?/;

/**
 * Validate a store id (6 digits) and a backend host (fdN-courses.leclercdrive.fr).
 * The host ends up in URLs the browser navigates to, so it must never point
 * anywhere else.
 */
export function validateStore(storeId: string, noPR: string, host: string): string | null {
  if (!STORE_ID_RE.test(storeId)) return `Identifiant magasin invalide : « ${storeId} » (6 chiffres).`;
  if (!STORE_ID_RE.test(noPR)) return `Point de retrait invalide : « ${noPR} » (6 chiffres).`;
  if (!HOST_RE.test(host)) return `Host invalide : « ${host} » (attendu : fdN-courses.leclercdrive.fr).`;
  return null;
}

/**
 * Extract the store from a Leclerc Drive store page URL, e.g.
 * https://fd4-courses.leclercdrive.fr/magasin-997471-000070-Paris/… — piéton
 * relays have a delivery point (noPL) and a retrieval point (noPR) that differ.
 */
export function parseStoreUrl(url: string): StoreSelection | null {
  const m = STORE_URL_RE.exec(url);
  if (!m) return null;
  const [, host, storeId, noPR, slug] = m;
  let name: string | undefined;
  if (slug) {
    try {
      name = decodeURIComponent(slug).replace(/-/g, " ");
    } catch {
      name = slug;
    }
  }
  return { storeId, noPR, host, name };
}

const CONFIG_DIR = join(homedir(), ".mcp-leclerc-drive");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export class StoreState {
  private selection: StoreSelection;

  constructor(config: LeclercConfig) {
    const fallback: StoreSelection = {
      storeId: config.storeId,
      noPR: config.storeId,
      host: config.host,
    };
    this.selection = readPersisted() ?? fallback;
  }

  current(): StoreSelection {
    return this.selection;
  }

  set(selection: StoreSelection): void {
    this.selection = selection;
    writePersisted(selection);
  }

  /** Whether a store was explicitly chosen (persisted), rather than the env/default fallback. */
  get isPersisted(): boolean {
    return existsSync(CONFIG_FILE);
  }

  /** Path of the persisted config file, for user-facing messages. */
  get configPath(): string {
    return CONFIG_FILE;
  }
}

function readPersisted(): StoreSelection | null {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    const o = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (o && typeof o.storeId === "string" && typeof o.host === "string") {
      return {
        storeId: o.storeId,
        noPR: typeof o.noPR === "string" ? o.noPR : o.storeId,
        host: o.host,
        name: typeof o.name === "string" ? o.name : undefined,
      };
    }
  } catch {
    /* ignore corrupt/unreadable config — fall back to defaults */
  }
  return null;
}

function writePersisted(selection: StoreSelection): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(selection, null, 2) + "\n", "utf8");
}
