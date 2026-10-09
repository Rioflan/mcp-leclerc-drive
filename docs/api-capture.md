# Leclerc Drive — Reverse-engineered API (validated 2026-06-13)

Captured live against store **053701** (La Ville-aux-Dames) on host
`fd9-courses.leclercdrive.fr`. All endpoints below were observed AND replayed
successfully from the page context with `credentials: 'include'` (cookies,
incl. DataDome, replayed).

> Path note: the store path is `magasin-{id}-{id}` for the API (e.g.
> `magasin-053701-053701`). The trailing `-La-Ville-aux-Dames` slug appears in
> the HTML page URLs but is **cosmetic** — the backend keys off the id.

## 0. Auth / anti-bot

- ✅ **v0.3 (current): requests run inside a real Chrome via CDP** (see
  `src/browser.ts`), so they carry the browser's cookies + TLS fingerprint +
  solved DataDome challenge. This is the only approach that survives DataDome's
  *active* mode. The cookie-replay notes below document the earlier (v0.1–0.2)
  approach and why it was abandoned.
- ⚠️⚠️ **DataDome escalates to "active" mode and then cookie-replay is dead.**
  After enough automated traffic (and it hits real end users too), DataDome stops
  accepting the cookie alone and requires the JS challenge to be executed. Then a
  Node `fetch` gets **403 even with a fresh, browser-valid `datadome` cookie and
  a changed IP**, while the real browser still loads fine. Not recoverable by
  refreshing Chrome. → v0.3 fixes this by *being* a real browser.
- [v0.1–0.2, superseded] Session was cookie-based: replay the full `Cookie`
  header from a logged-in browser.
- ⚠️ **DataDome** bot protection is active (`api-js.datadome.co/js/`). A
  `datadome` cookie is part of the session and **must** be replayed, or requests
  will be challenged. Confirmed: a cold Node `fetch` (no cookies) gets **HTTP
  403** with a DataDome challenge; replaying the browser cookies (incl.
  `datadome`) returns the real **HTTP 200** page. This is the main fragility of
  the cookie-replay approach.
- The MCP reads these cookies straight from the local Chrome profile
  (`chrome-cookies-secure`), so no manual copy-paste is needed — see
  `src/auth/cookies.ts`.
- ⚠️ **Bursts get struck.** Observed live: firing ~5 cart mutations in parallel
  immediately triggered DataDome — both writes *and* subsequent reads returned
  403 for that client, while the real browser session stayed fine. Recovery:
  refresh Leclerc Drive in Chrome (re-issues a valid `datadome` cookie). The
  client now serializes + spaces out + retries all requests to avoid this — see
  `src/leclerc/throttle.ts`. Keep a human-like cadence; don't parallelize.
- Mutating requests send header `X-Requested-With: XMLHttpRequest` and
  `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`.

## 1. search_product — `GET .../recherche.aspx?TexteRecherche={query}`

- Server-rendered HTML (ASP.NET). **No separate search XHR.**
- Needs the session cookie (DataDome blocks anonymous fetches), but no account
  is required beyond a valid browser session.
- In the **raw HTML**, products are passed to widget init calls as
  `Utilitaires.widget.initOptions('..._pnlElementProduit', {"objContenu":{"lstElements":[{"objElement":{ ...iIdProduit... }}]}})`.
  (The `_objDataSourceGroupeTrieFiltre` name only exists as a client-side global
  built from this — don't key off it server-side.) The client extracts products
  by scanning the HTML for the smallest JSON object enclosing each `iIdProduit`
  (= `objElement`, pure JSON). Validated live: `search("café")` → 200 products.
  Each product object exposes:

  | Field | Meaning |
  | --- | --- |
  | `iIdProduit` | **product id** (used for all cart ops), e.g. `2612` |
  | `sLibelleLigne1`, `sLibelleLigne2` | label (2 lines) |
  | `nrPVUnitaireTTC` / `sPrixUnitaire` | unit price (numeric / formatted) |
  | `sPrixPromo` | promo price when applicable |
  | `nrPVParUniteDeMesureTTC` / `sPrixParUniteDeMesure` | price per L/kg |
  | `iQteDisponible` | stock available (0 → unavailable) |
  | `iQuantitePanier` | quantity currently in cart |
  | `sUrlVignetteProduit` | thumbnail URL |
  | `iIdRayon`, `iIdFamille`, `niIdSousFamille` | category ids |

- Product images also load from
  `fd9-photos.leclercdrive.fr/image.ashx?id={photoId}&use=l&cat=p` and
  Nutri-Score from `...&use=nsc` (note: photo id ≠ `iIdProduit`).
- **Nutri-Score** (validated 2026-10-09) is not a product field: every store page
  (search, cart, usual products, lists) carries sticker entries in
  `"objStickers":{"lstProduitsStickers":[...]}`, one per product and sticker type:

  ```json
  {"iIdProduit": 171757, "sTypeSticker": "NUTRISCORE",
   "objSticker": {"sTypeSticker": "NUTRISCORE", "sTexteAlternatif": "Nutri Score B",
                  "sUrlCheminFinal": "image.ashx?id=2389083&use=nsc&..."}}
  ```

  The letter is read from `sTexteAlternatif`. **G** means the brand does not
  publish it and is treated as unknown. Products with no NUTRISCORE sticker
  (eggs, fresh produce…) have none.

## 2. add / update / remove — `POST .../panier.aspx?op=1`

Single endpoint for all cart mutations. `op=1` constant.

- **Body**: `d=<URL-encoded JSON>` (one form field named `d`).
- **JSON payload**:

  ```json
  {
    "eTypeAction": 1,
    "iIdProduit": "2612",
    "iQuantite": 2,
    "sNoPointLivraison": "053701",
    "objContexteProvenanceArticle": {
      "eOrigine": 4, "eTypePage": 3,
      "sTexteRecherche": "lait", "eVue": 0,
      "sInformationsComplementaires": "uni-2"
    }
  }
  ```

  - `eTypeAction`: **1** = add / increase, **2** = decrease / remove.
  - `iQuantite`: the **new absolute target quantity** (NOT a delta).
  - **Remove** = `eTypeAction: 2`, `iQuantite: 0`. ✅ validated (cart went to 0).
  - `objContexteProvenanceArticle` is analytics context and is **optional** —
    removals succeeded without it.

- **Response**: JSON array of events. Relevant ones, keyed by `sIdUnique`:
  - `Produit{id}` (`eTypeEvenement` 101/103/104): per-line state —
    `iQuantitePanier`, `rTotalAPayer`/`sTotalAPayer` (line total).
  - `Rayon{id}` (503): aisle rollup.
  - **`Panier{store}` (`eTypeEvenement` 1): cart grand total** —
    `iQuantitePanier` (total items), `rTotalAPayer`/`sTotalAPayer`,
    `sTotalHorsReductions`, `sMontantEconomies`, `fQuantiteDisponibleDepassee`.

  → Read the `Panier{store}` event for the authoritative cart total after any op.

## 3. get_cart

- `GET .../panier.aspx` (no `op`) → **404**. There is no plain cart page at that
  path.
- Instead, **every store page embeds the cart** in the "Panier" context:
  - `"lstProduits":[ {full product records} ]` — full `objElement`s with labels,
    `iQuantitePanier`, and per-line `rTotalAPayer`/`sTotalAPayer`.
  - `"lstProduitsLight":[ {"iIdProduit","iQtePanier","rTotalAPayer",...} ]` —
    a lightweight summary (no labels), immediately followed by the cart totals
    `"iQuantitePanier"`, `"sTotalHorsReductions"`, **`"sTotalAPayer"`** (grand total).
- Implementation (validated live): fetch `recherche.aspx?TexteRecherche=<no-match
  token>` so the page carries only cart records, extract the `lstProduits` array
  (exact key, so it doesn't match `lstProduitsLight`), map each record, and read
  the grand total from the `sTotalAPayer` next to `lstProduitsLight`.
- Note: cart line records use `iQuantitePanier` (full list) / `iQtePanier`
  (light list) — the client accepts either.

## 4. Store locator (find_stores) — `api-recherchemagasins.leclercdrive.fr`

A clean JSON REST API (separate from the ASP.NET store sites), validated live
2026-06-13. Behind DataDome like the rest — replay the Chrome cookie (the
`datadome` cookie on `.leclercdrive.fr` covers this subdomain). Base:
`https://api-recherchemagasins.leclercdrive.fr/API_RechercheMagasins/api/v1`.

Three chained calls:

1. `GET /autocomplete?search={postal|city}&provider=Woosmap`
   → `{ postalCodes: [ { id, postalCode, city } ], pointsLivraisonParNom, ... }`.
   Take `postalCodes[0].id` (an opaque Woosmap token).
2. `GET /autocomplete/coordinates?id={id}&provider=Woosmap`
   → `{ latitude, longitude }` for the place.
3. `GET /MapPoint/nearby?latitude={lat}&longitude={lng}&postalCode={cp}`
   → `{ points: [ store, ... ] }`, nearest first.

Each `point` carries: `name`, **`noPL`** (store id, zero-padded string),
**`noPR`** (retrieval point; == noPL for drives), `serviceType`
(`drive` / `relais` / `livraison`), `distance` (km), `postalCode`,
`coordinates {latitude, longitude}`, and **`urlSiteCourse` / `urlBase`** — the
store's shopping host (e.g. `fd8`/`fd9`/`fd14-courses.leclercdrive.fr`, **varies
per store**). The client maps these into the active `StoreSelection`
(see `src/store.ts`, `src/leclerc/locator.ts`).

⚠️ **Session is bound to one drive.** Shopping (search/cart) only works against
the drive the Chrome session is currently logged into. `set_store` to a store the
browser isn't on yields a "session expirée" page. Replaying Leclerc's
"switch drive" call to rebind the session server-side is an open item (would let
set_store switch to any drive) — see below.

## 5. Usual products & shopping lists (validated 2026-10-09)

Leclerc Drive has no "favourites" feature as such; the two closest are below.
Both are server-rendered store pages (`GET`, logged-in account), with products as
the usual `objElement` records (§1) and the cart embedded as on every page (§3).

- **Usual products** — `GET .../produits-habituels.aspx`. All products in one page
  (182 on a real account, no pagination). Only read the widget
  `initOptions('..._pnlElementProduitHabituels', {...})`: an account with no drive
  history gets a "Premier drive ?" page whose `..._pnlPouraientVousPlaire` widget
  holds *recommendations*, which must not be reported as the user's products.
- **Lists** — `GET .../mes-listes.aspx` links each list as
  `<a id="..._hlDetailsListe" href=".../detail-liste-{id}.aspx">{name}</a>`
  followed by "(N produit(s))". A list's products come from
  `GET .../detail-liste-{id}.aspx`, widget `..._pnlElementProduitDetailListe`.
  Product records carry `fAppartientAUneListe`.

## Open items / to refine

- Confirm `objContexteProvenanceArticle` can be fully omitted on **add** (only
  verified omittable on remove).
- Find a clean read-only cart endpoint if one exists (avoid HTML scrape).
- DataDome cookie lifetime / refresh behaviour for long-lived sessions.
- **Reverse-engineer the "switch drive" call** so `set_store` can rebind the
  session to any drive server-side (today it must match the browser's drive).
- Checkout / slot-booking flow (out of scope).
