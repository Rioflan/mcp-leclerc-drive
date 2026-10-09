// Analyse des pages magasin (recherche, produits habituels, listes) sur des extraits
// reproduisant la structure capturée (docs/api-capture.md §1 et §5).
// À lancer après `npm run build` : npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLists, productsFromPage } from "../dist/leclerc/client.js";

const product = (id, label, stock = 5) =>
  `{"objElement":{"sType":"Produit","iIdProduit":${id},"sLibelleLigne1":"${label}","sLibelleLigne2":"1kg",` +
  `"nrPVUnitaireTTC":2.5,"iQteDisponible":${stock},"iQuantitePanier":0}}`;
const sticker = (id, text, type = "NUTRISCORE") =>
  `{"sNoPointLivraison":"123456","objSticker":{"sTypeSticker":"${type}","sTexteAlternatif":"${text}"},` +
  `"sTypeSticker":"${type}","iIdElement":${id},"iIdProduit":${id}}`;

const page = `
  <script>Utilitaires.widget.initOptions('x_pnlElementProduit', {"objContenu":{"lstElements":[
    ${product(1, "Yaourt nature")}, ${product(2, "Lait bio", 0)}, ${product(3, "Biscuits")}]}});
  var ctx = {"lstProduits":[{"sType":"Produit","iIdProduit":99,"sLibelleLigne1":"Ligne du panier","iQuantitePanier":2}],
    "lstProduitsLight":[{"iIdProduit":99,"iQtePanier":2}]};
  var st = {"objStickers":{"lstProduitsStickers":[${sticker(1, "Nutri Score B")}, ${sticker(2, "Nutri Score G")},
    ${sticker(3, "Bio", "QUALITE")}]}};</script>`;

test("produits de la page, sans les lignes du panier ni les stickers", () => {
  const products = productsFromPage(page);
  assert.deepEqual(products.map((p) => p.id), ["1", "2", "3"]);
  assert.equal(products[1].available, false);
  assert.equal(products[0].label, "Yaourt nature 1kg");
});

test("Nutri-Score lu dans les stickers ; G (non communiqué) ignoré", () => {
  const byId = Object.fromEntries(productsFromPage(page).map((p) => [p.id, p.nutriScore]));
  assert.deepEqual(byId, { 1: "B", 2: undefined, 3: undefined });
});

const usualPage = `
  <script>Utilitaires.widget.initOptions('ctl00_ctl00_main_ctl00_pnlElementProduitHabituels', {"objContenu":{"lstElements":[
    ${product(10, "Lait")}, ${product(11, "Pain")}]}});
  Utilitaires.widget.initOptions('ctl00_ctl00_main_ctl00_pnlPouraientVousPlaire', {"objContenu":{"lstElements":[
    ${product(20, "Recommandation")}]}});
  var st = {"objStickers":{"lstProduitsStickers":[${sticker(11, "Nutri Score A")}]}};</script>`;

test("widget ciblé : produits habituels sans les recommandations", () => {
  const products = productsFromPage(usualPage, "_pnlElementProduitHabituels");
  assert.deepEqual(products.map((p) => [p.id, p.nutriScore]), [["10", undefined], ["11", "A"]]);
  // Compte sans historique : seul le bloc de recommandations est présent.
  const noHistory = usualPage.replace(/initOptions\('[^']*Habituels'[\s\S]*?\}\}\);/, "");
  assert.deepEqual(productsFromPage(noHistory, "_pnlElementProduitHabituels"), []);
});

test("listes : id, nom décodé et nombre de produits", () => {
  const html = `
    <a id="ctl00_rptListeDesListes_ctl00_hlDetailsListe" href="https://fd1-courses.leclercdrive.fr/magasin-1-1-X/detail-liste-47270827.aspx">Favoris</a>
    <span>(1 produit)</span>
    <a id="ctl00_rptListeDesListes_ctl01_hlDetailsListe" href="/magasin-1-1-X/detail-liste-5.aspx">Pr&#233;f&#233;r&#233;s <b>bio</b></a>
    <span>(12 produits)</span>`;
  assert.deepEqual(parseLists(html), [
    { id: "47270827", name: "Favoris", productCount: 1 },
    { id: "5", name: "Préférés bio", productCount: 12 },
  ]);
  assert.deepEqual(parseLists("<p>Aucune liste</p>"), []);
});
