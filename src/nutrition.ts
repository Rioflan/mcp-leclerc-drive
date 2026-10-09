/**
 * Nutri-Score enrichment for products whose listing page carries none.
 *
 * Order: the Leclerc product page (its sticker is sometimes missing from
 * listings), then Open Food Facts by barcode. Results — including "no score",
 * e.g. fresh produce or eggs, which are exempt — are cached on disk next to the
 * store selection, so each product costs one Leclerc request per TTL at most.
 * The file is shared by every process of the container (MCP server, bridge):
 * writes re-read it and replace it atomically.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Product, ProductDetails } from "./types.js";

export type NutriSource = "leclerc" | "openfoodfacts";

export interface NutriEntry {
  /** A–E, or null when no source has one. */
  grade: string | null;
  source: NutriSource | null;
  ean?: string;
  checkedAt: string;
}

const DAY_MS = 24 * 3600_000;
/** A known score is stable; an absent one is retried sooner (OFF gets new data). */
const TTL_FOUND_MS = 90 * DAY_MS;
const TTL_MISSING_MS = 30 * DAY_MS;
const GRADE_RE = /^[A-E]$/;

export const DEFAULT_CACHE_FILE = join(homedir(), ".mcp-leclerc-drive", "nutriscore.json");

export class NutriCache {
  private entries: Record<string, NutriEntry> = {};

  constructor(
    private readonly file: string = DEFAULT_CACHE_FILE,
    private readonly now: () => number = Date.now,
  ) {
    this.entries = this.readFile();
  }

  private readFile(): Record<string, NutriEntry> {
    try {
      const o = JSON.parse(readFileSync(this.file, "utf8"));
      return o && o.version === 1 && typeof o.entries === "object" ? o.entries : {};
    } catch {
      return {};
    }
  }

  private fresh(e: NutriEntry | undefined): e is NutriEntry {
    if (!e) return false;
    const age = this.now() - Date.parse(e.checkedAt);
    return age >= 0 && age < (e.grade ? TTL_FOUND_MS : TTL_MISSING_MS);
  }

  /** Re-read the file so entries written by another process are seen. */
  reload(): void {
    this.entries = { ...this.entries, ...this.readFile() };
  }

  get(productId: string): NutriEntry | undefined {
    const e = this.entries[productId];
    return this.fresh(e) ? e : undefined;
  }

  /** True when the product has no score and no fresh cache entry. */
  needsLookup(p: Product): boolean {
    return !p.nutriScore && !this.get(p.id);
  }

  set(productId: string, entry: NutriEntry): void {
    this.entries = { ...this.readFile(), ...this.entries, [productId]: entry };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }) + "\n", "utf8");
    renameSync(tmp, this.file);
  }

  /** Fill missing scores from the cache (scores read on the page always win). */
  apply<T extends Product>(p: T): T {
    if (p.nutriScore) return p;
    const e = this.get(p.id);
    return e?.grade && e.source ? { ...p, nutriScore: e.grade, nutriScoreSource: e.source } : p;
  }
}

// ---- Open Food Facts -----------------------------------------------------

export interface OffProduct {
  name?: string;
  brands?: string;
  nutriScore?: string;
  novaGroup?: number;
  /** Per 100 g / 100 ml. */
  nutriments: Partial<Record<"energyKcal" | "fat" | "saturatedFat" | "sugars" | "salt" | "proteins" | "fiber", number>>;
  url: string;
}

const OFF_FIELDS = "product_name,brands,nutriscore_grade,nova_group,nutriments";
const OFF_NUTRIMENTS = {
  energyKcal: "energy-kcal_100g",
  fat: "fat_100g",
  saturatedFat: "saturated-fat_100g",
  sugars: "sugars_100g",
  salt: "salt_100g",
  proteins: "proteins_100g",
  fiber: "fiber_100g",
} as const;

/**
 * Look a barcode up on Open Food Facts (public read API, no key; a descriptive
 * User-Agent is required by their usage policy). Returns null when unknown.
 */
export async function lookupOpenFoodFacts(
  ean: string,
  { fetchImpl = fetch, userAgent, timeoutMs = 10_000 }: { fetchImpl?: typeof fetch; userAgent: string; timeoutMs?: number },
): Promise<OffProduct | null> {
  if (!/^\d{8,14}$/.test(ean)) return null;
  const res = await fetchImpl(
    `https://world.openfoodfacts.org/api/v2/product/${ean}.json?fields=${OFF_FIELDS}`,
    { headers: { "User-Agent": userAgent, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Open Food Facts HTTP ${res.status}`);
  const data = (await res.json()) as { status?: number; product?: Record<string, unknown> };
  if (data.status !== 1 || !data.product) return null;
  const p = data.product;
  const grade = typeof p.nutriscore_grade === "string" ? p.nutriscore_grade.toUpperCase() : "";
  const raw = (p.nutriments ?? {}) as Record<string, unknown>;
  const nutriments: OffProduct["nutriments"] = {};
  for (const [k, field] of Object.entries(OFF_NUTRIMENTS)) {
    const v = raw[field];
    if (typeof v === "number" && Number.isFinite(v)) nutriments[k as keyof typeof OFF_NUTRIMENTS] = v;
  }
  return {
    name: typeof p.product_name === "string" ? p.product_name : undefined,
    brands: typeof p.brands === "string" ? p.brands : undefined,
    nutriScore: GRADE_RE.test(grade) ? grade : undefined,
    novaGroup: typeof p.nova_group === "number" ? p.nova_group : undefined,
    nutriments,
    url: `https://world.openfoodfacts.org/product/${ean}`,
  };
}

// ---- Resolution ----------------------------------------------------------

export interface NutriResolution {
  details: ProductDetails;
  entry: NutriEntry;
  off: OffProduct | null;
}

/**
 * Resolve one product's Nutri-Score (product page, then Open Food Facts when
 * enabled) and record the outcome in the cache.
 */
export async function resolveNutriScore(
  getDetails: (id: string) => Promise<ProductDetails>,
  cache: NutriCache,
  productId: string,
  opts: {
    openFoodFacts: boolean;
    userAgent: string;
    fetchImpl?: typeof fetch;
    /** Query Open Food Facts even when the page has a score (for its nutrition facts). */
    alwaysOpenFoodFacts?: boolean;
  },
): Promise<NutriResolution> {
  const details = await getDetails(productId);
  let off: OffProduct | null = null;
  if (opts.openFoodFacts && details.ean && (!details.product.nutriScore || opts.alwaysOpenFoodFacts)) {
    off = await lookupOpenFoodFacts(details.ean, opts).catch(() => null);
  }
  const fromPage = details.product.nutriScore;
  const entry: NutriEntry = fromPage
    ? { grade: fromPage, source: "leclerc", ean: details.ean, checkedAt: new Date().toISOString() }
    : off?.nutriScore
      ? { grade: off.nutriScore, source: "openfoodfacts", ean: details.ean, checkedAt: new Date().toISOString() }
      : { grade: null, source: null, ean: details.ean, checkedAt: new Date().toISOString() };
  cache.set(productId, entry);
  return { details, entry, off };
}
