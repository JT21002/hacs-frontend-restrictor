// Restrictor Card — v0.11
// - Overlay injecté dans le ha-card interne (pas de wrapper) → compatible Sections
// - Overlay désactivé en mode édition (détection robuste)
// - Filtrage par nom d’utilisateur (insensible à la casse)
// - Badge utilisateur (nom uniquement) si show_user: true
// - NEW: allow_navigation_when_locked → laisse passer la navigation en read_only
// - NEW: console_debug → logs console

(function () {

  const log = (...a) => console.info("[restrictor-card v0.11]", ...a);

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
    catch { const c=document.createElement("ha-card"); c.style.padding="12px"; c.style.color="var(--error-color,#db4437)"; c.textContent=`Restrictor Card: ${message}`; return c; }
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
      this._built = false;
      this._innerCard = null;
      this._cleanup = [];
      this._editObserver = null;
      this._lastEditState = false;
    }

    setConfig(config) {
      if (!config || !config.card) throw new Error('Restrictor Card: il manque la clé "card".');
      this._config = {
        allowed_users: Array.isArray(config.allowed_users) ? config.allowed_users : [],
        mode: config.mode || (config.read_only ? "read_only" : "read_only"), // "read_only" | "hidden"
        overlay_opacity: typeof config.overlay_opacity === "number" ? config.overlay_opacity : 0.0,
        show_user: !!config.show_user,
        allow_navigation_when_locked: !!config.allow_navigation_when_locked, // NEW
        console_debug: !!config.console_debug, // NEW
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
      this._cleanup.forEach(u => { try { u(); } catch {} });
      this._cleanup = [];
      if (this._editObserver) { try { this._editObserver.disconnect(); } catch {} }
      this._editObserver = null;
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
          this._build();
        }
      });
      this._editObserver.observe(target, { attributes: true, subtree: true, attributeFilter: ["class"] });
    }

    _findHaCard(el) {
      if (el?.shadowRoot) {
        const hc = el.shadowRoot.querySelector("ha-card");
        if (hc) return hc;
      }
      if (el && el.tagName && el.tagName.toLowerCase() === "ha-card") return el;
      return null;
    }

_addOverlayInside(targetHaCard, { showBadge, badgeText, opacity, showLock, allowNav, navPath }) {
  const overlay = document.createElement("div");
  overlay.className = "restrictor-overlay";
  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.zIndex = "9999";            // ⬅️ au-dessus de tout
  overlay.style.cursor = allowNav ? "pointer" : "not-allowed";
  overlay.style.background = `rgba(0,0,0,${opacity || 0})`;
  overlay.style.pointerEvents = "auto";     // ⬅️ capte tous les events

  // s’assurer que ha-card peut contenir un absolu
  const computed = getComputedStyle(targetHaCard);
  if (!computed.position || computed.position === "static") {
    targetHaCard.style.position = "relative";
  }

  const stopAll = (e) => {
    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();
  };

  // Bloque tout (y compris click)
  const events = [
    "click","mousedown","mouseup","touchstart","touchend","pointerdown","pointerup",
    "change","input","keydown","keyup","contextmenu","dblclick","dragstart","pointercancel"
  ];
  events.forEach(ev => {
    const h = (e) => stopAll(e);
    overlay.addEventListener(ev, h, true);
    this._cleanup.push(() => overlay.removeEventListener(ev, h, true));
  });

  // Navigation contrôlée (on gère nous-mêmes le clic)
  const onClick = (e) => {
    stopAll(e);
    if (allowNav && navPath) {
      try {
        const evt = new Event("location-changed", { bubbles: true, composed: true });
        history.pushState(null, "", navPath);
        window.dispatchEvent(evt);
      } catch {
        window.location.assign(navPath);
      }
    }
  };
  overlay.addEventListener("click", onClick, true);
  this._cleanup.push(() => overlay.removeEventListener("click", onClick, true));

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
  this._cleanup.push(() => { try { targetHaCard.removeChild(overlay); } catch {} });
}


    async _build() {
      // cleanup + watcher edit
      this.disconnectedCallback();
      this._watchEditMode();

      this._built = true;
      const root = this.shadowRoot;
      root.innerHTML = "";

      const innerCard = await createInnerCard(this._config.card, this._hass);
      this._innerCard = innerCard;
      root.appendChild(innerCard);

      const needUser = this._config.show_user || this._config.allowed_users.length > 0;
      let user = { id: "", name: "" };
      if (needUser) user = await this._getCurrentUser();

      // autorisation par nom
      let isAllowed = true;
      if (this._config.allowed_users.length > 0) {
        const uname = this._norm(user.name);
        const names = this._config.allowed_users.map(x => this._norm(x));
        isAllowed = names.includes(uname);
      }

      const editing = this._computeEditMode();
      if (this._config.console_debug) {
        log("editMode:", editing, "user:", user.name, "isAllowed:", isAllowed);
      }

      if (isAllowed) {
        if (this._config.show_user) {
          const hc = this._findHaCard(innerCard);
          if (hc) {
            this._addOverlayInside(hc, {
              showBadge: true,
              badgeText: `Utilisateur: ${user.name || "(inconnu)"}`,
              opacity: 0,
              showLock: false,
              allowNav: false,
              navPath: null
            });
          } else {
            const badge = document.createElement("div");
            badge.textContent = `Utilisateur: ${user.name || "(inconnu)"}`;
            badge.style.fontSize = "12px";
            badge.style.opacity = "0.72";
            badge.style.margin = "4px 8px";
            root.insertBefore(badge, innerCard);
          }
        }
        return;
      }

      if (this._config.mode === "hidden") {
        this.style.display = "none";
        return;
      }

      // Non autorisé
      if (!editing) {
        const hc = this._findHaCard(innerCard);
        if (hc) {
          this._addOverlayInside(hc, {
            showBadge: !!this._config.show_user,
            badgeText: `Utilisateur: ${user.name || "(inconnu)"}`,
            opacity: this._config.overlay_opacity,
            showLock: true,
            allowNav: this._config.allow_navigation_when_locked,
            navPath: this._config.card?.navigation_path || null
          });
        }
      }
      // En édition → aucun overlay.
    }
  }

  if (!customElements.get("restrictor-card"))
    customElements.define("restrictor-card", RestrictorCard);
})();
