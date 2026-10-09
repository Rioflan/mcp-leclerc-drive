// Nutri-Score complété : fiche produit, cache partagé, Open Food Facts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProductPage } from "../dist/leclerc/client.js";
import { lookupOpenFoodFacts, NutriCache, resolveNutriScore } from "../dist/nutrition.js";

const DAY = 24 * 3600_000;
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "nutri-")), "nutriscore.json");
const product = (id, extra = {}) => ({ id, label: `P${id}`, price: 1, available: true, ...extra });

test("fiche produit : EAN, marque, Nutri-Score du produit principal seulement", () => {
  const html = `<script>Utilitaires.widget.initOptions('ctl00_main_ctl00_pnlFicheProduit', {
    "objFiche":{"iIdProduit":6075,"sLibelleLigne1":"Quinoa","sLibelleMarque":"Marque rep&#232;re","sCodeEAN":"3564707079952","sOrigine":"France"},
    "objContenu":{"lstElements":[{"objElement":{"sType":"Produit","iIdProduit":6075,"sLibelleLigne1":"Quinoa","sLibelleLigne2":"500g","nrPVUnitaireTTC":3.45,"iQteDisponible":13}}]},
    "objStickers":{"lstProduitsStickers":[{"objSticker":{"sTexteAlternatif":"Nutri Score A"},"sTypeSticker":"NUTRISCORE","iIdProduit":6075}]}});
    Utilitaires.widget.initOptions('ctl00_main_ctl00_pnlProduitsAssocies', {"objContenu":{"lstElements":[{"objElement":{"sType":"Produit","iIdProduit":1,"sLibelleLigne1":"Autre","sCodeEAN":"0000000000000"}}]}});</script>`;
  const d = parseProductPage(html, "6075");
  assert.equal(d.ean, "3564707079952");
  assert.equal(d.brand, "Marque repère");
  assert.equal(d.product.nutriScore, "A");
  assert.equal(d.product.nutriScoreSource, "leclerc");
  assert.equal(d.product.available, true, "stock lu dans l'objElement, pas dans la fiche descriptive");
  assert.throws(() => parseProductPage(html, "1"), /introuvable/);
});

test("cache : application, priorité à la page, expiration, fichier partagé", () => {
  let now = Date.parse("2026-10-10T00:00:00Z");
  const file = tmpFile();
  const a = new NutriCache(file, () => now);
  a.set("1", { grade: "B", source: "openfoodfacts", ean: "123", checkedAt: new Date(now).toISOString() });
  a.set("2", { grade: null, source: null, checkedAt: new Date(now).toISOString() });

  assert.deepEqual(a.apply(product("1")), product("1", { nutriScore: "B", nutriScoreSource: "openfoodfacts" }));
  assert.equal(a.apply(product("1", { nutriScore: "A", nutriScoreSource: "leclerc" })).nutriScore, "A");
  assert.equal(a.needsLookup(product("2")), false, "absence récente : pas de nouvelle recherche");
  assert.equal(a.needsLookup(product("3")), true);

  // Un second processus (MCP / bridge) voit les entrées et les fusionne.
  const b = new NutriCache(file, () => now);
  b.set("3", { grade: "C", source: "leclerc", checkedAt: new Date(now).toISOString() });
  a.reload();
  assert.equal(a.get("3").grade, "C");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);

  now += 31 * DAY;
  assert.equal(a.get("2"), undefined, "absence expirée après 30 jours");
  assert.equal(a.get("1").grade, "B", "score conservé 90 jours");
  now += 60 * DAY;
  assert.equal(a.get("1"), undefined);
});

test("Open Food Facts : note, nutriments, produit inconnu, EAN invalide", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ua: init.headers["User-Agent"] });
    if (url.includes("/404")) return new Response("{}", { status: 404 });
    if (url.includes("3000000000000")) return Response.json({ status: 0 });
    return Response.json({
      status: 1,
      product: { product_name: "Quinoa", nutriscore_grade: "a", nova_group: 1, nutriments: { "energy-kcal_100g": 368, "salt_100g": 0.01, fat_100g: "x" } },
    });
  };
  const off = await lookupOpenFoodFacts("3564707079952", { fetchImpl, userAgent: "test/1" });
  assert.equal(off.nutriScore, "A");
  assert.deepEqual(off.nutriments, { energyKcal: 368, salt: 0.01 });
  assert.equal(calls[0].ua, "test/1");
  assert.equal(await lookupOpenFoodFacts("3000000000000", { fetchImpl, userAgent: "t" }), null);
  assert.equal(await lookupOpenFoodFacts("12ab", { fetchImpl, userAgent: "t" }), null);
  assert.equal(calls.length, 2, "EAN invalide : aucun appel");
});

test("résolution : page d'abord, Open Food Facts ensuite, absence mise en cache", async () => {
  const cache = new NutriCache(tmpFile());
  let offCalls = 0;
  const fetchImpl = async () => {
    offCalls++;
    return Response.json({ status: 1, product: { nutriscore_grade: "b" } });
  };
  const details = { "1": { product: product("1", { nutriScore: "A", nutriScoreSource: "leclerc" }), ean: "3564707079952" },
    "2": { product: product("2"), ean: "3564707079953" }, "3": { product: product("3") } };
  const get = async (id) => details[id];
  const opts = { openFoodFacts: true, userAgent: "t", fetchImpl };

  assert.equal((await resolveNutriScore(get, cache, "1", opts)).entry.source, "leclerc");
  assert.equal(offCalls, 0, "score sur la page : pas d'appel à OFF");
  assert.deepEqual((await resolveNutriScore(get, cache, "2", opts)).entry.grade, "B");
  assert.equal(cache.get("2").source, "openfoodfacts");
  assert.equal((await resolveNutriScore(get, cache, "3", opts)).entry.grade, null, "sans EAN : aucun score");
  assert.equal((await resolveNutriScore(get, cache, "2", { ...opts, openFoodFacts: false })).entry.grade, null);
});
