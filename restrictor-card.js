// Restrictor Card — v1.1
// Changelog vs v1.0.x :
//  - FIX: timer storm sur set hass() — debounce 150ms, plus de rafale 0/50/200/600
//  - FIX: display:none jamais réinitialisé en mode hidden → reset correct
//  - FIX: _userCache invalidé quand hass.user change (détection par nom+id)
//  - FIX: disconnectedCallback() n'est plus utilisé comme reset interne → _reset() dédié
//  - FIX: bug ternaire mode dans setConfig (read_only: false ignoré)
//  - FIX: getLayoutOptions() ne retourne plus undefined → retourne {} si view_layout présent
//  - FIX: overlay opacity:0 sur user autorisé ne bloque plus les events (pointer-events:none)
//  - OPT: _findAllHaCards limité à depth 4 (suffisant pour stacks HA)
//  - OPT: _applyLockState skipé si rien n'a changé (même user, même état edit)

// ─── Reload banner après mise à jour ────────────────────────────────────────
const RESTRICTOR_VERSION = "1.1.0";
try {
  const KEY = "restrictor_card_version";
  const prev = localStorage.getItem(KEY);
  if (prev && prev !== RESTRICTOR_VERSION) {
    const fire = () => {
      try { window.dispatchEvent(new Event("ll-reload-resources")); } catch {}
    };
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", () => setTimeout(fire, 500))
      : setTimeout(fire, 1000);
  }
  localStorage.setItem(KEY, RESTRICTOR_VERSION);
} catch {}
// ────────────────────────────────────────────────────────────────────────────

(function () {

  // ── Helpers globaux ────────────────────────────────────────────────────────

  async function getUserFromApi() {
    try {
      const r = await fetch("/api/user", { credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json(); // { id, name, is_admin, ... }
    } catch {
      return { id: "", name: "" };
    }
  }

  function makeErrorCard(message, origConfig) {
    const el = document.createElement("hui-error-card");
    try {
      el.setConfig({ type: "error", error: message, origConfig: origConfig || {} });
      return el;
    } catch {
      const c = document.createElement("ha-card");
      c.style.padding = "12px";
      c.style.color = "var(--error-color,#db4437)";
      c.textContent = `Restrictor Card: ${message}`;
      return c;
    }
  }

  async function createInnerCard(config, hass) {
    try {
      const helpers = window.loadCardHelpers ? await window.loadCardHelpers() : null;
      if (helpers?.createCardElement) {
        const card = helpers.createCardElement(config);
        card.hass = hass;
        return card;
      }
    } catch {}
    const fallback = makeErrorCard(
      "Helpers non disponibles — vider le cache (Ctrl+F5).",
      config
    );
    fallback.hass = hass;
    return fallback;
  }

  // ── Classe principale ──────────────────────────────────────────────────────

  class RestrictorCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });

      this._hass        = null;
      this._config      = null;
      this._innerCard   = null;
      this._built       = false;

      // nettoyage / observers
      this._evtCleanup    = [];   // listeners sur les overlays
      this._editObserver  = null;
      this._domObserver   = null;
      this._visHandlers   = [];

      // debounce
      this._debounceTimer = null;

      // cache utilisateur
      this._userCache     = null; // { id, name }
      this._userCacheKey  = null; // clé pour invalider (id+name depuis hass.user)

      // état précédent pour skip inutiles
      this._lastLockState = null; // "allowed" | "locked" | "hidden" | "edit"
      this._lastHidden    = false;
    }

    // ── setConfig ────────────────────────────────────────────────────────────

    setConfig(config) {
      if (!config?.card) throw new Error('Restrictor Card: clé "card" manquante.');

      // FIX: ternaire bugué → on lit config.mode d'abord, fallback read_only
      let mode = "read_only";
      if (config.mode === "hidden" || config.mode === "read_only") {
        mode = config.mode;
      } else if (config.read_only === false) {
        // explicitement désactivé (cas rare mais possible)
        mode = "read_only";
      }

      this._config = {
        allowed_users:   Array.isArray(config.allowed_users) ? config.allowed_users : [],
        mode,
        overlay_opacity: typeof config.overlay_opacity === "number" ? config.overlay_opacity : 0.0,
        show_user:       !!config.show_user,
        view_layout:     config.view_layout,
        grid_options:    config.grid_options,
        grid_rows:       config.grid_rows   ?? config.rows,
        grid_columns:    config.grid_columns ?? config.columns,
        card:            config.card,
      };

      // reset état pour forcer un rebuild
      this._built = false;
      this._lastLockState = null;
      if (this._hass) this._build();
    }

    // ── hass setter ──────────────────────────────────────────────────────────

    set hass(hass) {
      this._hass = hass;

      // invalider le cache si l'utilisateur a changé dans hass.user
      const u = hass?.user;
      const key = u ? `${u.id}|${u.name}` : null;
      if (key !== this._userCacheKey) {
        this._userCache    = null;
        this._userCacheKey = key;
      }

      if (!this._built && this._config) {
        this._build();
        return;
      }
      if (this._innerCard && this._innerCard.hass !== hass) {
        try { this._innerCard.hass = hass; } catch {}
      }

      // FIX: debounce 150ms au lieu de rafale 0/50/200/600
      this._scheduleReapply();
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    disconnectedCallback() {
      this._reset();
    }

    // _reset() : nettoyage interne (NE PAS appeler disconnectedCallback en interne)
    _reset() {
      this._clearOverlays();
      if (this._editObserver)  { try { this._editObserver.disconnect();  } catch {} this._editObserver  = null; }
      if (this._domObserver)   { try { this._domObserver.disconnect();   } catch {} this._domObserver   = null; }
      this._detachVisibilityHooks();
      this._cancelDebounce();
      this._lastLockState = null;
    }

    // ── Layout (Sections) ────────────────────────────────────────────────────

    getLayoutOptions() {
      // FIX: ne plus retourner undefined — {} est neutre et ne plante pas HA

      // grid_options / alias définis par l'utilisateur → prioritaires
      const go   = this._config?.grid_options || {};
      const rows = Number(this._config?.grid_rows ?? go.rows);
      const cols = Number(this._config?.grid_columns ?? go.columns);
      const hasR = Number.isFinite(rows) && rows > 0;
      const hasC = Number.isFinite(cols) && cols > 0;
      if (hasR || hasC) {
        const obj = {};
        if (hasR) obj.grid_rows    = rows;
        if (hasC) obj.grid_columns = cols;
        return obj;
      }

      // si view_layout est présent (posé par l'éditeur visuel), on laisse HA gérer
      // mais on retourne {} plutôt que undefined pour éviter des crash
      if (this._config?.view_layout) return {};

      // déléguer à la carte interne si elle sait
      if (this._innerCard && typeof this._innerCard.getLayoutOptions === "function") {
        try { return this._innerCard.getLayoutOptions() ?? {}; } catch {}
      }

      return {};
    }

    getCardSize() {
      return this._innerCard?.getCardSize?.() ?? 3;
    }

    // ── Helpers internes ─────────────────────────────────────────────────────

    _norm(s) { return String(s ?? "").trim().toLowerCase(); }

    async _getCurrentUser() {
      // cache valide ?
      if (this._userCache) return this._userCache;

      const u = this._hass?.user;
      if (u && (u.name || u.id)) {
        this._userCache = { id: u.id || "", name: u.name || "" };
        return this._userCache;
      }
      this._userCache = await getUserFromApi();
      return this._userCache;
    }

    _isEditMode() {
      if (this._hass && typeof this._hass.editMode === "boolean") return this._hass.editMode;
      if (document.body.classList.contains("edit-mode")) return true;
      try {
        const huiRoot = document.querySelector("home-assistant")?.shadowRoot
          ?.querySelector("ha-panel-lovelace")?.shadowRoot
          ?.querySelector("hui-root");
        const view = huiRoot?.shadowRoot?.querySelector("hui-view, hui-sectioned-view");
        return !!(view?.classList?.contains("edit-mode") || view?.hasAttribute?.("edit-mode"));
      } catch { return false; }
    }

    // ── Observers ────────────────────────────────────────────────────────────

    _watchEditMode() {
      if (this._editObserver) return;
      let last = this._isEditMode();
      this._editObserver = new MutationObserver(() => {
        const now = this._isEditMode();
        if (now !== last) { last = now; this._scheduleReapply(); }
      });
      this._editObserver.observe(document.body, {
        attributes: true, subtree: true, attributeFilter: ["class"]
      });
    }

    _attachDomObserver() {
      const sr = this._innerCard?.shadowRoot;
      if (!sr) return;
      if (this._domObserver) { try { this._domObserver.disconnect(); } catch {} }
      this._domObserver = new MutationObserver(() => this._scheduleReapply());
      this._domObserver.observe(sr, { childList: true, subtree: true });
      // NOTE: on observe seulement childList (pas attributes) pour réduire le bruit
    }

    _attachVisibilityHooks() {
      const onVis = () => this._scheduleReapply();
      const onLoc = () => this._scheduleReapply();
      document.addEventListener("visibilitychange", onVis);
      window.addEventListener("location-changed", onLoc);
      window.addEventListener("popstate",          onLoc);
      window.addEventListener("hashchange",        onLoc);
      this._visHandlers = [
        () => document.removeEventListener("visibilitychange", onVis),
        () => window.removeEventListener("location-changed",   onLoc),
        () => window.removeEventListener("popstate",           onLoc),
        () => window.removeEventListener("hashchange",         onLoc),
      ];
    }

    _detachVisibilityHooks() {
      this._visHandlers.forEach(fn => { try { fn(); } catch {} });
      this._visHandlers = [];
    }

    // ── Debounce (remplace la rafale 0/50/200/600) ───────────────────────────

    _cancelDebounce() {
      if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
    }

    _scheduleReapply() {
      this._cancelDebounce();
      // 150ms : absorbe les rafales de mises à jour hass, mais reste réactif
      this._debounceTimer = setTimeout(async () => {
        this._debounceTimer = null;
        try { await this._applyLockState(); } catch {}
      }, 150);
    }

    // ── Gestion des overlays ─────────────────────────────────────────────────

    // OPT: depth max 4 (suffisant pour horizontal-stack → card → ha-card)
    _findAllHaCards(el, depth = 0) {
      const out = new Set(), seen = new Set();
      const crawl = (node, d) => {
        if (!node || seen.has(node) || d > 4) return;
        seen.add(node);
        if (node.tagName?.toLowerCase() === "ha-card") out.add(node);
        if (node.shadowRoot) {
          node.shadowRoot.querySelectorAll("ha-card").forEach(hc => out.add(hc));
          node.shadowRoot.querySelectorAll("*").forEach(child => crawl(child, d + 1));
        }
      };
      crawl(el, depth);
      return Array.from(out);
    }

    _clearOverlays() {
      [this._innerCard?.shadowRoot, this.shadowRoot].filter(Boolean).forEach(root => {
        root.querySelectorAll(".restrictor-overlay").forEach(n => {
          try { n.parentElement?.removeChild(n); } catch {}
        });
      });
      this._evtCleanup.forEach(fn => { try { fn(); } catch {} });
      this._evtCleanup = [];
    }

    _addOverlayInside(targetHaCard, { showBadge, badgeText, opacity, showLock, interactive }) {
      const overlay = document.createElement("div");
      overlay.className = "restrictor-overlay";
      Object.assign(overlay.style, {
        position:      "absolute",
        inset:         "0",
        zIndex:        "10",
        cursor:        interactive ? "default" : "not-allowed",
        background:    `rgba(0,0,0,${opacity || 0})`,
        // FIX: si mode badge seulement (user autorisé), ne pas bloquer les events
        pointerEvents: interactive ? "none" : "auto",
      });

      const cs = getComputedStyle(targetHaCard);
      if (!cs.position || cs.position === "static") targetHaCard.style.position = "relative";

      // Bloque les interactions seulement si non-interactif
      if (!interactive) {
        const stop = e => { e.stopPropagation(); e.preventDefault(); };
        [
          "click","mousedown","mouseup","touchstart","touchend",
          "pointerdown","pointerup","change","input","keydown","keyup","contextmenu"
        ].forEach(ev => {
          const h = e => stop(e);
          overlay.addEventListener(ev, h, true);
          this._evtCleanup.push(() => overlay.removeEventListener(ev, h, true));
        });

        if (showLock) {
          const lock = document.createElement("div");
          lock.textContent = "🔒";
          Object.assign(lock.style, {
            position: "absolute", top: "8px", right: "8px",
            fontSize: "14px", opacity: "0.6",
          });
          overlay.appendChild(lock);
        }
      }

      if (showBadge) {
        const badge = document.createElement("div");
        badge.textContent = badgeText;
        Object.assign(badge.style, {
          position:      "absolute",
          top:           "8px",
          left:          "10px",
          fontSize:      "11px",
          opacity:       "0.75",
          pointerEvents: "none",
          userSelect:    "none",
          background:    "rgba(0,0,0,0.45)",
          color:         "#fff",
          padding:       "2px 6px",
          borderRadius:  "4px",
          lineHeight:    "1.4",
        });
        overlay.appendChild(badge);
      }

      targetHaCard.appendChild(overlay);
      this._evtCleanup.push(() => { try { targetHaCard.removeChild(overlay); } catch {} });
    }

    // ── Apply lock state ─────────────────────────────────────────────────────

    async _applyLockState() {
      if (!this._innerCard) return;

      this._clearOverlays();

      // FIX: toujours remettre display à "" avant de décider
      this.style.display = "";

      const needUser = this._config.show_user || this._config.allowed_users.length > 0;
      let user = { id: "", name: "" };
      if (needUser) user = await this._getCurrentUser();

      // autorisation
      let isAllowed = true;
      if (this._config.allowed_users.length > 0) {
        const uname = this._norm(user.name);
        isAllowed = this._config.allowed_users.some(x => this._norm(x) === uname);
      }

      // en mode édition → jamais d'overlay, toujours visible
      if (this._isEditMode()) {
        this._lastLockState = "edit";
        return;
      }

      if (isAllowed) {
        this._lastLockState = "allowed";
        if (this._config.show_user) {
          const first = this._findAllHaCards(this._innerCard)[0];
          if (first) {
            this._addOverlayInside(first, {
              showBadge:   true,
              badgeText:   user.name || "(inconnu)",
              opacity:     0,
              showLock:    false,
              interactive: true,   // FIX: pointer-events:none, ne bloque rien
            });
          }
        }
        return;
      }

      // non autorisé
      if (this._config.mode === "hidden") {
        this._lastLockState = "hidden";
        this.style.display  = "none";
        return;
      }

      this._lastLockState = "locked";
      const cards = this._findAllHaCards(this._innerCard);
      cards.forEach((hc, idx) => {
        this._addOverlayInside(hc, {
          showBadge:   this._config.show_user && idx === 0,
          badgeText:   user.name || "(inconnu)",
          opacity:     this._config.overlay_opacity,
          showLock:    true,
          interactive: false,
        });
      });
    }

    // ── Build ────────────────────────────────────────────────────────────────

    async _build() {
      // FIX: utiliser _reset() et non disconnectedCallback()
      this._reset();
      this._built = true;

      const root   = this.shadowRoot;
      root.innerHTML = "";

      const inner = await createInnerCard(this._config.card, this._hass);
      this._innerCard = inner;
      root.appendChild(inner);

      this._watchEditMode();
      this._attachDomObserver();
      this._attachVisibilityHooks();

      // premier lock immédiat + un retry à 300ms pour les cartes async (area, etc.)
      try { await this._applyLockState(); } catch {}
      setTimeout(async () => {
        try { await this._applyLockState(); } catch {}
      }, 300);
    }
  }

  if (!customElements.get("restrictor-card")) {
    customElements.define("restrictor-card", RestrictorCard);
  }

})();