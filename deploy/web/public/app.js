// Interface Alertes Drive. Tout le contenu venant du site est inséré via
// textContent (jamais innerHTML) : un libellé produit ne peut pas injecter de HTML.

const $ = (sel) => document.querySelector(sel);
const TABS = ["panier", "ruptures", "recherche", "alertes", "reglages"];

const state = {
  csrf: null,
  cart: null,
  cartError: null,
  alerts: [],
  status: null,
  search: null,
};

// ---------- API ----------

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

async function api(method, path, body) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && state.csrf) headers["X-CSRF-Token"] = state.csrf;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") {
    showLogin();
    throw new ApiError(401, "unauthorized", "Session expirée, reconnecte-toi.");
  }
  if (!res.ok) throw new ApiError(res.status, data.error, data.message || `Erreur ${res.status}`);
  return data;
}

// ---------- Utilitaires d'affichage ----------

const eur = (n) =>
  typeof n === "number" ? n.toLocaleString("fr-FR", { style: "currency", currency: "EUR" }) : "";

function relTime(iso) {
  if (!iso) return "jamais";
  const diff = Date.parse(iso) - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / 86_400_000), "day");
}

function el(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

const pill = (text, kind) => el("span", { className: `pill ${kind}`, text });

let flashTimer;
function flash(message, isError = false) {
  const box = $("#flash");
  box.textContent = message;
  box.classList.toggle("is-error", isError);
  box.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (box.hidden = true), isError ? 8000 : 4000);
}

const ERROR_HINTS = {
  session_expired: "Session Leclerc Drive expirée : reconnecte-toi via le VNC.",
  store_not_configured: "Aucun magasin configuré : connecte-toi dans le VNC puis « Détecter mon magasin » dans Réglages.",
  blocked: "Le site a bloqué la requête (anti-bot). Réessaie dans quelques minutes.",
  bridge_unreachable: "Le conteneur navigateur ne répond pas.",
};
const explain = (err) => ERROR_HINTS[err.code] || err.message;

/** Désactive un bouton pendant une action asynchrone. */
async function busy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "…";
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// ---------- Alertes ----------

const alertFor = (productId) => state.alerts.find((a) => a.productId === productId && a.status === "armed");

async function createAlert(product, query, button) {
  await busy(button, async () => {
    try {
      const { alert } = await api("POST", "/api/alerts", {
        productId: product.id,
        label: product.label,
        query: query || product.label,
      });
      state.alerts = [...state.alerts.filter((a) => a.id !== alert.id), alert];
      flash(`Alerte créée : ${product.label}`);
    } catch (err) {
      flash(explain(err), true);
    }
  });
  renderAll();
}

// ---------- Rendu ----------

function productItem(p, { query, showQuantity } = {}) {
  const node = $("#product-tpl").content.firstElementChild.cloneNode(true);
  const img = node.querySelector(".thumb");
  if (p.imageUrl && /^https:\/\/[a-z0-9-]+\.leclercdrive\.fr\//.test(p.imageUrl)) img.src = p.imageUrl;
  else img.remove();

  node.querySelector(".label").textContent = p.label;
  const price = showQuantity ? `${p.quantity} × ${eur(p.price)} = ${eur(p.lineTotal)}` : eur(p.price);
  node.querySelector(".meta").textContent = [price, p.pricePerUnit].filter(Boolean).join(" · ");
  node.querySelector(".status").append(p.available ? pill("Disponible", "ok") : pill("En rupture", "ko"));

  const btn = node.querySelector(".alert-btn");
  if (alertFor(p.id)) {
    btn.textContent = "Alerte active";
    btn.disabled = true;
  } else if (p.available) {
    btn.remove();
  } else {
    btn.textContent = "M'alerter";
    btn.classList.add("primary");
    btn.addEventListener("click", () => createAlert(p, query, btn));
  }
  return node;
}

function renderCart() {
  const list = $("#cart-list");
  const oosList = $("#oos-list");
  list.replaceChildren();
  oosList.replaceChildren();

  if (state.cartError) {
    $("#cart-summary").textContent = explain(state.cartError);
    $("#oos-summary").textContent = explain(state.cartError);
    return;
  }
  if (!state.cart) {
    $("#cart-summary").textContent = "Chargement du panier…";
    $("#oos-summary").textContent = "Chargement du panier…";
    return;
  }

  const { items, total, itemCount } = state.cart;
  const oos = items.filter((i) => !i.available);
  $("#cart-summary").textContent = items.length
    ? `${itemCount} article(s), ${items.length} référence(s) — total ${eur(total)}`
    : "Panier vide.";
  list.append(...items.map((p) => productItem(p, { showQuantity: true })));

  const missing = oos.reduce((s, i) => s + i.lineTotal, 0);
  $("#oos-summary").textContent = oos.length
    ? `${oos.length} référence(s) en rupture, soit ${eur(missing)} sur ${eur(total)}.`
    : "Aucun article du panier n'est en rupture.";
  oosList.append(...oos.map((p) => productItem(p, { showQuantity: true })));

  const badge = $("#badge-ruptures");
  badge.textContent = String(oos.length);
  badge.hidden = oos.length === 0;
}

function renderSearch() {
  const list = $("#search-list");
  list.replaceChildren();
  const s = state.search;
  if (!s) return;
  $("#search-summary").textContent = s.products.length
    ? `${s.products.length} résultat(s) pour « ${s.query} ».`
    : `Aucun résultat pour « ${s.query} ».`;
  list.append(...s.products.map((p) => productItem(p, { query: s.query })));
}

function renderAlerts() {
  const list = $("#alerts-list");
  list.replaceChildren();
  const alerts = [...state.alerts].sort(
    (a, b) => (a.status === "armed" ? 0 : 1) - (b.status === "armed" ? 0 : 1) || b.createdAt.localeCompare(a.createdAt),
  );
  const armed = alerts.filter((a) => a.status === "armed").length;
  const sch = state.status?.scheduler;
  const next = sch?.running ? "vérification en cours" : sch?.nextRunAt ? `prochaine vérification ${relTime(sch.nextRunAt)}` : "";
  $("#alerts-summary").textContent = alerts.length
    ? `${armed} alerte(s) active(s)${next ? ` — ${next}` : ""}.`
    : "Aucune alerte. Crée-en depuis l'onglet Ruptures ou Recherche.";

  for (const a of alerts) {
    let status;
    if (a.status === "triggered") status = pill(`Notifiée ${relTime(a.triggeredAt)}`, "ok");
    else if (a.lastAvailable === null && a.lastCheckedAt) status = pill("Introuvable à la dernière vérification", "warn");
    else status = pill(a.lastCheckedAt ? `En rupture — vérifiée ${relTime(a.lastCheckedAt)}` : "En attente de vérification", "ko");

    const buttons = el("div", { className: "buttons" });
    if (a.status === "triggered") {
      const rearm = el("button", { text: "Réarmer", attrs: { type: "button" } });
      rearm.addEventListener("click", () =>
        busy(rearm, async () => {
          try {
            const { alert } = await api("POST", `/api/alerts/${a.id}/rearm`);
            state.alerts = state.alerts.map((x) => (x.id === alert.id ? alert : x));
            renderAll();
          } catch (err) {
            flash(explain(err), true);
          }
        }),
      );
      buttons.append(rearm);
    }
    const del = el("button", { className: "danger", text: "Supprimer", attrs: { type: "button" } });
    del.addEventListener("click", () =>
      busy(del, async () => {
        try {
          await api("DELETE", `/api/alerts/${a.id}`);
          state.alerts = state.alerts.filter((x) => x.id !== a.id);
          renderAll();
        } catch (err) {
          flash(explain(err), true);
        }
      }),
    );
    buttons.append(del);

    list.append(
      el("li", { className: "alert" }, [
        el("div", { className: "info" }, [
          el("span", { className: "label", text: a.label }),
          el("span", { className: "meta muted", text: `Créée ${relTime(a.createdAt)} · id ${a.productId}` }),
        ]),
        el("span", { className: "status" }, [status]),
        buttons,
      ]),
    );
  }

  const badge = $("#badge-alertes");
  badge.textContent = String(armed);
  badge.hidden = armed === 0;
}

function renderSettings() {
  const s = state.status;
  const dl = $("#settings");
  dl.replaceChildren();
  if (!s) return;
  const sch = s.scheduler;
  const minutes = (ms) => `${Math.round(ms / 60_000)} min`;
  const rows = [
    ["Magasin", s.store ? `${s.store.name ?? "?"} (${s.store.storeId}-${s.store.noPR} @ ${s.store.host})` : s.storeError || "non configuré"],
    ["Fréquence", `toutes les ${minutes(sch.intervalMs)} + 0 à ${minutes(sch.jitterMs)} aléatoires`],
    ["Dernière vérification", `${relTime(sch.lastRunAt)}${sch.lastSuccessAt ? ` (dernier succès ${relTime(sch.lastSuccessAt)})` : ""}`],
    ["Prochaine vérification", sch.running ? "en cours" : relTime(sch.nextRunAt)],
    ["Dernière erreur", sch.lastError ? `${sch.lastError} (${sch.consecutiveFailures} échec(s) d'affilée)` : "aucune"],
    ["Notifications", s.ntfy],
  ];
  for (const [k, v] of rows) dl.append(el("dt", { text: k }), el("dd", { text: v }));
  $("#store-name").textContent = s.store?.name ? `Drive ${s.store.name}` : "";
}

function renderAll() {
  renderCart();
  renderSearch();
  renderAlerts();
  renderSettings();
}

// ---------- Chargements ----------

async function loadCart() {
  state.cart = null;
  state.cartError = null;
  renderCart();
  try {
    state.cart = await api("GET", "/api/cart");
  } catch (err) {
    state.cartError = err;
  }
  renderAll();
}

async function loadAlerts() {
  state.alerts = (await api("GET", "/api/alerts")).alerts;
}

async function loadStatus() {
  state.status = await api("GET", "/api/status");
}

async function refreshMeta() {
  try {
    await Promise.all([loadAlerts(), loadStatus()]);
  } catch (err) {
    if (err.status !== 401) flash(explain(err), true);
  }
  renderAll();
}

// ---------- Navigation ----------

function showTab() {
  const current = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "panier";
  for (const t of TABS) {
    $(`#tab-${t}`).hidden = t !== current;
    document.querySelector(`[data-tab="${t}"]`).setAttribute("aria-selected", String(t === current));
  }
  if (current === "recherche") $("#search-q").focus();
}

function showLogin() {
  state.csrf = null;
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#password").focus();
}

async function showApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  showTab();
  await refreshMeta();
  loadCart();
}

// ---------- Évènements ----------

// e.submitter est null si le formulaire est soumis par Entrée dans certains navigateurs.
const submitButton = (form) => form.querySelector('button[type="submit"]');

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  await busy(submitButton(e.currentTarget), async () => {
    try {
      const { csrf } = await api("POST", "/api/login", { password: $("#password").value });
      state.csrf = csrf;
      $("#password").value = "";
      await showApp();
    } catch (err) {
      $("#login-error").textContent = err.message;
    }
  });
});

$("#logout").addEventListener("click", async () => {
  await api("POST", "/api/logout").catch(() => {});
  showLogin();
});

$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#search-q").value.trim();
  if (q.length < 2) return;
  $("#search-summary").textContent = "Recherche en cours…";
  $("#search-list").replaceChildren();
  await busy(submitButton(e.currentTarget), async () => {
    try {
      state.search = await api("GET", `/api/search?q=${encodeURIComponent(q)}`);
      renderSearch();
    } catch (err) {
      state.search = null;
      $("#search-summary").textContent = explain(err);
    }
  });
});

const ACTIONS = {
  "reload-cart": () => loadCart(),
  "check-now": async () => {
    try {
      const { result } = await api("POST", "/api/check");
      if (result.error) flash(`Vérification échouée : ${result.error}`, true);
      else flash(`${result.checked} alerte(s) vérifiée(s), ${result.triggered} notifiée(s).`);
    } catch (err) {
      flash(explain(err), true);
    }
    await refreshMeta();
  },
  "detect-store": async () => {
    try {
      const { store } = await api("POST", "/api/store/detect");
      flash(`Magasin détecté : ${store.name ?? store.storeId}`);
    } catch (err) {
      flash(explain(err), true);
    }
    await refreshMeta();
    loadCart();
  },
  "test-notify": async () => {
    try {
      await api("POST", "/api/notify/test");
      flash("Notification envoyée.");
    } catch (err) {
      flash(explain(err), true);
    }
  },
};

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (btn && ACTIONS[btn.dataset.action]) busy(btn, ACTIONS[btn.dataset.action]);
});

window.addEventListener("hashchange", showTab);

// Rafraîchit statut et alertes (pas le panier : chaque lecture interroge le site).
setInterval(() => {
  if (!$("#app").hidden && document.visibilityState === "visible") refreshMeta();
}, 60_000);

// ---------- Démarrage ----------

try {
  const { csrf } = await api("GET", "/api/session");
  state.csrf = csrf;
  await showApp();
} catch {
  showLogin();
}
