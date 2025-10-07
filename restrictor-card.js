// Restrictor Card — v0.14
// - Verrouillage robuste des stacks (horizontal/vertical/grid) : overlay sur TOUS les <ha-card> descendants
// - Ré-application automatique via MutationObserver (re-render des tiles/stacks)
// - Overlay OFF en mode édition (compat. Sections)
// - Filtrage par NOM d’utilisateur uniquement, insensible à la casse
// - Badge utilisateur (nom) seulement si show_user: true
// - Option console_debug pour tracer

(function () {

  const LOGTAG = "[restrictor-card v0.14]";
  const log = (...a) => console.info(LOGTAG, ...a);

  async function getUserFromApi() {
    try {
      const r = await fetch("/api/user", { credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch {
      return { id: "", name: "" };
    }
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
      this._lastEditState = false;
    }

    setConfig(config) {
      if (!config || !config.card) throw new Error('Restrictor Card: il manque la clé "card".');
      this._config = {
        allowed_users: Array.isArray(config.allowed_users) ? config.allowed_users : [],
        mode: config.mode || (config.read_only ? "read_only" : "read_only"), // "read_only" | "hidden"
        overlay_opacity: typeof config.overlay_opacity === "number" ? config.overlay_opacity : 0.0,
        show_user: !!config.show_user,
        console_debug: !!config.console_debug,
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
    }

    disconnectedCallback() {
      this._cleanup.forEach(fn => { try { fn(); } catch {} });
      this._cleanup = [];
      if (this._editObserver) { try { this._editObserver.disconnect(); } catch {} }
      this._editObserver = null;
      if (this._domObserver) { try { this._domObserver.disconnect(); } catch {} }
      this._domObserver = null;
    }

    getCardSize() { return this._innerCard?.getCardSize?.() ?? 3; }

    _norm(s) { return String(s ?? "").trim().toLowerCase(); }

    async _getCurrentUser() {
      const u = this._hass?.user;
      if (u && (u.name || u.id)) return { id: u.id || "", name: u.name || "" };
      return await getUserFromApi();
    }

    _computeEditMode() {
      if (this._hass && typeof this._hass.editMode === "boolean") return this._hass.editMode;
      if (document.body.classList.contains("edit-mode")) return true;
      try {
        const huiRoot = document.querySelector("home-assistant")?.shadowRoot
          ?.querySelector("ha-panel-lovelace")?.shadowRoot
          ?.querySelector("hui-root");
        const view = huiRoot?.shadowRoot?.querySelector("hui-view, hui-sectioned-view");
        if (view?.classList?.contains("edit-mode") || view?.hasAttribute?.("edit-mode")) return true;
      } catch {}
      return false;
    }

    _watchEditMode() {
      const target = document.body;
      if (!target || this._editObserver) return;
      this._lastEditState = this._computeEditMode();
      this._editObserver = new MutationObserver(() => {
        const now = this._computeEditMode();
        if (now !== this._lastEditState) {
          this._lastEditState = now;
          this._applyLockState(); // re-render sans overlay en édition
        }
      });
      this._editObserver.observe(target, { attributes: true, subtree: true, attributeFilter: ["class"] });
    }

    // Récupère TOUS les ha-card descendants (stacks, tiles, etc.)
    _collectAllHaCards(rootEl) {
      const out = new Set();
      const seen = new Set();

      const crawl = (el, depth = 0) => {
        if (!el || seen.has(el) || depth > 5) return;
        seen.add(el);

        if (el.shadowRoot) {
          el.shadowRoot.querySelectorAll("ha-card").forEach(hc => out.add(hc));
          el.shadowRoot.querySelectorAll("*").forEach(child => crawl(child, depth + 1));
        }
      };

      crawl(rootEl, 0);
      // fallback si la carte elle-même est un ha-card
      if (rootEl && rootEl.tagName && rootEl.tagName.toLowerCase() === "ha-card") out.add(rootEl);

      return Array.from(out);
    }

    _clearOverlays() {
      // supprime tous les overlays/badges que nous avons créés
      const root = this._innerCard?.shadowRoot || this.shadowRoot;
      if (!root) return;
      const all = root.querySelectorAll(".restrictor-overlay");
      all.forEach(n => { try { n.parentElement.removeChild(n); } catch {} });
      this._cleanup.forEach(fn => { try { fn(); } catch {} });
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

      const computed = getComputedStyle(targetHaCard);
      if (computed.position === "static" || !computed.position) {
        targetHaCard.style.position = "relative";
      }

      const stop = e => { e.stopPropagation(); e.preventDefault(); };
      [
        "click","mousedown","mouseup","touchstart","touchend","pointerdown",
        "pointerup","change","input","keydown","keyup","contextmenu"
      ].forEach(ev => {
        const h = e => stop(e);
        overlay.addEventListener(ev, h, true);
        this._cleanup.push(() => overlay.removeEventListener(ev, h, true));
      });

      if (showLock) {
        const lockEl = document.createElement("div");
        lockEl.textContent = "🔒";
        lockEl.style.position = "absolute";
        lockEl.style.top = "8px";
        lockEl.style.right = "8px";
        lockEl.style.fontSize = "14px";
        lockEl.style.opacity = "0.6";
        overlay.appendChild(lockEl);
      }

      if (showBadge) {
        const badge = document.createElement("div");
        badge.textContent = badgeText;
        badge.style.position = "absolute";
        badge.style.left = "10px";
        badge.style.bottom = "6px";
        badge.style.fontSize = "12px";
        badge.style.opacity = "0.72";
        badge.style.pointerEvents = "none";
        badge.style.userSelect = "none";
        overlay.appendChild(badge);
      }

      targetHaCard.appendChild(overlay);
      this._cleanup.push(() => { try { targetHaCard.removeChild(overlay); } catch {}});
    }

    _observeDomChanges() {
      // Observe le shadowRoot de la carte interne : si les sous-cartes changent, on ré-applique
      const sr = this._innerCard?.shadowRoot;
      if (!sr) return;
      if (this._domObserver) { try { this._domObserver.disconnect(); } catch {} }
      this._domObserver = new MutationObserver(() => this._applyLockState());
      this._domObserver.observe(sr, { childList: true, subtree: true });
    }

    async _applyLockState() {
      if (!this._innerCard) return;

      // Nettoie overlays précédents
      this._clearOverlays();

      const needUser = this._config.show_user || this._config.allowed_users.length > 0;
      let user = { id: "", name: "" };
      if (needUser) user = await this._getCurrentUser();

      // Autorisation
      let isAllowed = true;
      if (this._config.allowed_users.length > 0) {
        const uname = this._norm(user.name);
        const names = this._config.allowed_users.map(x => this._norm(x));
        isAllowed = names.includes(uname);
      }

      const editing = this._computeEditMode();
      if (this._config.console_debug) {
        const cards = this._collectAllHaCards(this._innerCard);
        log("editMode:", editing, "user:", user.name, "isAllowed:", isAllowed, "ha-cards:", cards.length);
      }

      // En édition : pas d'overlay (laisser la mise en page/handles)
      if (editing) return;

      // Autorisé : badge optionnel sur la 1ère sous-carte
      if (isAllowed) {
        if (this._config.show_user) {
          const cards = this._collectAllHaCards(this._innerCard);
          const hc = cards[0];
          if (hc) {
            this._addOverlayInside(hc, {
              showBadge: true,
              badgeText: `Utilisateur: ${user.name || "(inconnu)"}`,
              opacity: 0,
              showLock: false
            });
          }
        }
        return;
      }

      // Non autorisé
      if (this._config.mode === "hidden") {
        this.style.display = "none";
        return;
      }

      // Place un overlay sur chaque sous-<ha-card> trouvé
      const cards = this._collectAllHaCards(this._innerCard);
      if (cards.length === 0) return;
      cards.forEach((hc, idx) => {
        this._addOverlayInside(hc, {
          showBadge: !!this._config.show_user && idx === 0,
          badgeText: `Utilisateur: ${user.name || "(inconnu)"}`,
          opacity: this._config.overlay_opacity,
          showLock: true
        });
      });
    }

    async _build() {
      // cleanup watchers/overlays
      this.disconnectedCallback();

      this._built = true;
      const root = this.shadowRoot;
      root.innerHTML = "";

      const innerCard = await createInnerCard(this._config.card, this._hass);
      this._innerCard = innerCard;
      root.appendChild(innerCard);

      // Observe mode édition & DOM interne
      this._watchEditMode();
      this._observeDomChanges();

      // Applique l'état (autorisé / verrouillé)
      this._applyLockState();
    }
  }

  if (!customElements.get("restrictor-card"))
    customElements.define("restrictor-card", RestrictorCard);
})();
