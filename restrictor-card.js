// Restrictor Card — v0.7 (user-name only, badge inside card - bottom-left)
(function () {

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

  async function getUserFromApi() {
    try {
      const r = await fetch("/api/user", { credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json(); // { id, name, ... }
    } catch {
      return { id: "", name: "" };
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
      this._built = false;
      this._innerCard = null;
    }

    setConfig(config) {
      if (!config || !config.card)
        throw new Error('Restrictor Card: il manque la clé "card".');

      this._config = {
        allowed_users: Array.isArray(config.allowed_users) ? config.allowed_users : [],
        mode: config.mode || (config.read_only ? "read_only" : "read_only"), // "read_only" | "hidden"
        overlay_opacity:
          typeof config.overlay_opacity === "number" ? config.overlay_opacity : 0.0,
        show_user: !!config.show_user,
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

    getCardSize() {
      return this._innerCard?.getCardSize?.() ?? 3;
    }

    _norm(s) {
      return String(s ?? "").trim().toLowerCase();
    }

    async _getCurrentUser() {
      const u = this._hass?.user;
      if (u && (u.name || u.id)) return { id: u.id || "", name: u.name || "" };
      return await getUserFromApi();
    }

    _wrapWithHaCard(inner, { showBadge, badgeText, lock, overlayOpacity }) {
      const wrapper = document.createElement("ha-card");
      wrapper.style.position = "relative";
      wrapper.style.display = "block";
      wrapper.appendChild(inner);

      if (showBadge) {
        const badge = document.createElement("div");
        badge.textContent = badgeText;
        badge.style.position = "absolute";
        badge.style.left = "10px";
        badge.style.bottom = "6px";          // 👈 badge dans la carte, bas-gauche
        badge.style.fontSize = "12px";
        badge.style.opacity = "0.72";
        badge.style.pointerEvents = "none";
        badge.style.userSelect = "none";
        wrapper.appendChild(badge);
      }

      if (typeof overlayOpacity === "number") {
        const overlay = document.createElement("div");
        overlay.style.position = "absolute";
        overlay.style.inset = "0";
        overlay.style.zIndex = "10";
        overlay.style.cursor = "not-allowed";
        overlay.style.background = `rgba(0,0,0,${overlayOpacity})`;
        const stop = e => { e.stopPropagation(); e.preventDefault(); };
        [
          "click","mousedown","mouseup","touchstart","touchend","pointerdown",
          "pointerup","change","input","keydown","keyup","contextmenu"
        ].forEach(ev => overlay.addEventListener(ev, stop, true));
        wrapper.appendChild(overlay);

        if (lock) {
          const lockEl = document.createElement("div");
          lockEl.textContent = "🔒";
          lockEl.style.position = "absolute";
          lockEl.style.top = "8px";
          lockEl.style.right = "8px";
          lockEl.style.fontSize = "14px";
          lockEl.style.opacity = "0.6";
          overlay.appendChild(lockEl);
        }
      }

      return wrapper;
    }

    async _build() {
      this._built = true;
      const root = this.shadowRoot;
      root.innerHTML = "";

      const innerCard = await createInnerCard(this._config.card, this._hass);
      this._innerCard = innerCard;

      // Faut-il consulter l'utilisateur ?
      const needUser = this._config.show_user || this._config.allowed_users.length > 0;
      let user = { id: "", name: "" };
      if (needUser) user = await this._getCurrentUser();

      // Autorisation par NOM uniquement (insensible à la casse)
      let isAllowed = true;
      if (this._config.allowed_users.length > 0) {
        const uname = this._norm(user.name);
        const names = this._config.allowed_users.map(x => this._norm(x));
        isAllowed = names.includes(uname);
      }

      const badgeText = this._config.show_user ? `Utilisateur: ${user.name || "(inconnu)"}` : "";

      if (isAllowed) {
        // Autorisé → carte interactive
        if (this._config.show_user) {
          const wrapped = this._wrapWithHaCard(innerCard, {
            showBadge: true, badgeText, lock: false, overlayOpacity: undefined
          });
          root.appendChild(wrapped);
        } else {
          root.appendChild(innerCard);
        }
        return;
      }

      if (this._config.mode === "hidden") {
        this.style.display = "none";
        return;
      }

      // Non autorisé → lecture seule (overlay) + badge + cadenas
      const wrapped = this._wrapWithHaCard(innerCard, {
        showBadge: !!this._config.show_user,
        badgeText,
        lock: true,
        overlayOpacity: this._config.overlay_opacity
      });
      root.appendChild(wrapped);
    }
  }

  if (!customElements.get("restrictor-card"))
    customElements.define("restrictor-card", RestrictorCard);
})();
