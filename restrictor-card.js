// Restrictor Card — v1.0.2 (no reload-banner)
// - Verrouillage robuste (Area + stacks), ré-applique sur mutations / navigation / visibilité
// - Overlay OFF en mode édition (vue Sections)
// - Filtrage par NOM d’utilisateur (insensible à la casse)
// - Support grid_options (rows/columns) + alias; priorité à view_layout de l’éditeur
// - Badge utilisateur déplacé EN HAUT À GAUCHE (show_user: true)

(function () {

  async function getUserFromApi() {
    try {
      const r = await fetch("/api/user", { credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch { return { id: "", name: "" }; }
  }

  function makeErrorCard(message, origConfig) {
    const el = document.createElement("hui-error-card");
    try { el.setConfig({ type: "error", error: message, origConfig: origConfig || {} }); return el; }
    catch {
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
    const fallback = makeErrorCard("Helpers non disponibles (ressource/front). Vider le cache.", config);
    fallback.hass = hass;
    return fallback;
  }

  class RestrictorCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._hass = null;
      this._config = null;
      this._innerCard = null;

      this._built = false;
      this._cleanup = [];
      this._editObserver = null;
      this._domObserver = null;
      this._reapplyTimer = null;
      this._visHandlers = [];

      this._userCache = null;
    }

    // ---------------- Config ----------------
    setConfig(config) {
      if (!config || !config.card) throw new Error('Restrictor Card: il manque la clé "card".');
      this._config = {
        allowed_users: Array.isArray(config.allowed_users) ? config.allowed_users : [],
        mode: config.mode || (config.read_only ? "read_only" : "read_only"), // "read_only" | "hidden"
        overlay_opacity: typeof config.overlay_opacity === "number" ? config.overlay_opacity : 0.0,
        show_user: !!config.show_user,
        // mise en page :
        view_layout: config.view_layout,      // écrit par l’éditeur (prioritaire)
        grid_options: config.grid_options,    // { rows, columns }
        grid_rows: config.grid_rows ?? config.rows,
        grid_columns: config.grid_columns ?? config.columns,
        // carte réelle :
        card: config.card,
      };
      this._built = false;
      if (this._hass) this._build();
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._built && this._config) this._build();
      if (this._innerCard && this._innerCard.hass !== hass) {
        try { this._innerCard.hass = hass; } catch {}
      }
      // re-lock décalé quand hass met à jour les états
      this._scheduleReapply("hass-update");
    }

    disconnectedCallback() {
      this._cleanup.forEach(u => { try { u(); } catch {} });
      this._cleanup = [];
      if (this._editObserver) { try { this._editObserver.disconnect(); } catch {} }
      this._editObserver = null;
      if (this._domObserver) { try { this._domObserver.disconnect(); } catch {} }
      this._domObserver = null;
      this._clearReapplyTimer();
      this._detachVisibilityHooks();
    }

    // ---------------- Layout (Sections) ----------------
    // Priorités:
    // 1) view_layout (posé par l’éditeur) → laisser HA décider (undefined)
    // 2) grid_options/alias → renvoyer {grid_rows, grid_columns}
    // 3) si la carte interne expose getLayoutOptions → relayer
    // 4) sinon → {} (neutre)
    getLayoutOptions() {
      if (this._config?.view_layout) return undefined;

      const go = this._config?.grid_options || {};
      const rows = Number(this._config?.grid_rows ?? go.rows);
      const cols = Number(this._config?.grid_columns ?? go.columns);
      const hasRows = Number.isFinite(rows) && rows > 0;
      const hasCols = Number.isFinite(cols) && cols > 0;
      if (hasRows || hasCols) {
        const obj = {};
        if (hasRows) obj.grid_rows = rows;
        if (hasCols) obj.grid_columns = cols;
        return obj;
      }

      if (this._innerCard && typeof this._innerCard.getLayoutOptions === "function") {
        try { return this._innerCard.getLayoutOptions(); } catch {}
      }

      return {};
    }

    getCardSize() { return this._innerCard?.getCardSize?.() ?? 3; }
    _norm(s) { return String(s ?? "").trim().toLowerCase(); }

    async _getCurrentUser() {
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

    _watchEditMode() {
      const target = document.body;
      if (!target || this._editObserver) return;
      let last = this._isEditMode();
      this._editObserver = new MutationObserver(() => {
        const now = this._isEditMode();
        if (now !== last) { last = now; this._scheduleReapply("edit-mode"); }
      });
      this._editObserver.observe(target, { attributes: true, subtree: true, attributeFilter: ["class"] });
    }

    _attachDomObserver() {
      const sr = this._innerCard?.shadowRoot;
      if (!sr) return;
      if (this._domObserver) { try { this._domObserver.disconnect(); } catch {} }
      this._domObserver = new MutationObserver(() => this._scheduleReapply("dom-mutation"));
      this._domObserver.observe(sr, { childList: true, subtree: true, attributes: true });
    }

    _attachVisibilityHooks() {
      const onVis = () => this._scheduleReapply("visibilitychange");
      const onLoc = () => this._scheduleReapply("location-changed");
      document.addEventListener("visibilitychange", onVis);
      window.addEventListener("location-changed", onLoc);
      window.addEventListener("popstate", onLoc);
      window.addEventListener("hashchange", onLoc);
      this._visHandlers = [
        () => document.removeEventListener("visibilitychange", onVis),
        () => window.removeEventListener("location-changed", onLoc),
        () => window.removeEventListener("popstate", onLoc),
        () => window.removeEventListener("hashchange", onLoc),
      ];
    }
    _detachVisibilityHooks() {
      this._visHandlers.forEach(fn => { try { fn(); } catch {} });
      this._visHandlers = [];
    }

    _clearReapplyTimer() { if (this._reapplyTimer) { clearTimeout(this._reapplyTimer); this._reapplyTimer = null; } }
    _scheduleReapply() {
      this._clearReapplyTimer();
      const tries = [0, 50, 200, 600];
      let i = 0;
      const fire = async () => {
        try { await this._applyLockState(); } catch {}
        i += 1;
        if (i < tries.length) {
          this._reapplyTimer = setTimeout(fire, tries[i]);
        } else {
          this._reapplyTimer = null;
        }
      };
      this._reapplyTimer = setTimeout(fire, tries[i]);
    }

    // ---- util: trouver toutes les sous-cartes ha-card (stacks y compris) ----
    _findAllHaCards(el) {
      const out = new Set(), seen = new Set();
      const crawl = (node, depth = 0) => {
        if (!node || seen.has(node) || depth > 6) return;
        seen.add(node);
        if (node.shadowRoot) {
          node.shadowRoot.querySelectorAll("ha-card").forEach(hc => out.add(hc));
          node.shadowRoot.querySelectorAll("*").forEach(child => crawl(child, depth + 1));
        }
      };
      crawl(el, 0);
      if (el && el.tagName?.toLowerCase() === "ha-card") out.add(el);
      return Array.from(out);
    }

    _clearOverlays() {
      const roots = [this._innerCard?.shadowRoot, this.shadowRoot].filter(Boolean);
      roots.forEach(root => {
        root.querySelectorAll(".restrictor-overlay").forEach(n => { try { n.parentElement.removeChild(n); } catch {} });
      });
      this._cleanup.forEach(u => { try { u(); } catch {} });
      this._cleanup = [];
    }

    _addOverlayInside(targetHaCard, { showBadge, badgeText, opacity, showLock }) {
      const overlay = document.createElement("div");
      overlay.className = "restrictor-overlay";
      overlay.style.position = "absolute";
      overlay.style.inset = "0";
      overlay.style.zIndex = "10";
      overlay.style.cursor = "not-allowed";
      overlay.style.background = `rgba(0,0,0,${opacity || 0})`;

      const cs = getComputedStyle(targetHaCard);
      if (!cs.position || cs.position === "static") targetHaCard.style.position = "relative";

      const stop = e => { e.stopPropagation(); e.preventDefault(); };
      [
        "click","mousedown","mouseup","touchstart","touchend","pointerdown",
        "pointerup","change","input","keydown","keyup","contextmenu"
      ].forEach(ev => {
        const h = e => stop(e);
        overlay.addEventListener(ev, h, true);
        this._cleanup.push(() => overlay.removeEventListener(ev, h, true));
      });

      // 🔒 cadenas en HAUT DROIT
      if (showLock) {
        const l = document.createElement("div");
        l.textContent = "🔒";
        l.style.position = "absolute";
        l.style.top = "8px";
        l.style.right = "10px";
        l.style.fontSize = "15px";
        l.style.opacity = "0.7";
        overlay.appendChild(l);
      }

      // 👤 badge utilisateur en HAUT GAUCHE (show_user)
      if (showBadge) {
        const b = document.createElement("div");
        b.textContent = badgeText;
        b.style.position = "absolute";
        b.style.top = "8px";
        b.style.left = "10px";
        b.style.fontSize = "13px";
        b.style.fontWeight = "500";
        b.style.color = "var(--primary-text-color)";
        b.style.opacity = "0.85";
        b.style.pointerEvents = "none";
        b.style.userSelect = "none";
        overlay.appendChild(b);
      }

      targetHaCard.appendChild(overlay);
      this._cleanup.push(() => { try { targetHaCard.removeChild(overlay); } catch {} });
    }

    // ---------------- Apply lock ----------------
    async _applyLockState() {
      if (!this._innerCard) return;

      // nettoie
      this._clearOverlays();

      // utilisateur (si nécessaire)
      const needUser = this._config.show_user || (this._config.allowed_users?.length > 0);
      let user = { id: "", name: "" };
      if (needUser) user = await this._getCurrentUser();

      // autorisation
      let isAllowed = true;
      if (this._config.allowed_users?.length > 0) {
        const uname = this._norm(user.name);
        const names = this._config.allowed_users.map(x => this._norm(x));
        isAllowed = names.includes(uname);
      }

      // édition → jamais d’overlay
      if (this._isEditMode()) return;

      if (isAllowed) {
        if (this._config.show_user) {
          const first = this._findAllHaCards(this._innerCard)[0];
          if (first) this._addOverlayInside(first, {
            showBadge: true,
            badgeText: `Utilisateur: ${user.name || "(inconnu)"}`,
            opacity: 0,
            showLock: false
          });
        }
        return;
      }

      if (this._config.mode === "hidden") {
        this.style.display = "none";
        return;
      }

      // non autorisé → overlay sur chaque sous-carte
      const cards = this._findAllHaCards(this._innerCard);
      cards.forEach((hc, idx) => {
        this._addOverlayInside(hc, {
          showBadge: !!this._config.show_user && idx === 0,
          badgeText: `Utilisateur: ${user.name || "(inconnu)"}`,
          opacity: this._config.overlay_opacity,
          showLock: true
        });
      });
    }

    // ---------------- Build ----------------
    async _build() {
      // reset
      this.disconnectedCallback();

      this._built = true;
      const root = this.shadowRoot;
      root.innerHTML = "";

      // créer la carte interne
      const innerCard = await createInnerCard(this._config.card, this._hass);
      this._innerCard = innerCard;
      root.appendChild(innerCard);

      // observers
      this._watchEditMode();
      this._attachDomObserver();
      this._attachVisibilityHooks();

      // appliquer + retries
      this._scheduleReapply("initial-build");
    }
  }

  if (!customElements.get("restrictor-card"))
    customElements.define("restrictor-card", RestrictorCard);
})();
