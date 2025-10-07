// Restrictor Card — v0.9
// - Injecte overlay et badge DANS le ha-card interne (pas de wrapper) => meilleur support mise en page
// - Désactive overlay en mode édition
// - Filtrage par nom d'utilisateur (insensible à la casse)
// - Badge nom uniquement si show_user: true

(function () {

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
      this._cleanup = []; // listeners à retirer si rebuild
    }

    setConfig(config) {
      if (!config || !config.card) throw new Error('Restrictor Card: il manque la clé "card".');
      this._config = {
        allowed_users: Array.isArray(config.allowed_users) ? config.allowed_users : [],
        mode: config.mode || (config.read_only ? "read_only" : "read_only"), // "read_only" | "hidden"
        overlay_opacity: typeof config.overlay_opacity === "number" ? config.overlay_opacity : 0.0,
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

    disconnectedCallback() {
      this._cleanup.forEach(unsub => { try { unsub(); } catch {} });
      this._cleanup = [];
    }

    getCardSize() {
      return this._innerCard?.getCardSize?.() ?? 3;
    }

    _norm(s) { return String(s ?? "").trim().toLowerCase(); }

    async _getCurrentUser() {
      const u = this._hass?.user;
      if (u && (u.name || u.id)) return { id: u.id || "", name: u.name || "" };
      return await getUserFromApi();
    }

    _isEditMode() {
      return !!(this._hass?.editMode || document.body.classList.contains("edit-mode"));
    }

    _findHaCard(el) {
      // tente de trouver le <ha-card> de la carte interne
      if (el?.shadowRoot) {
        const hc = el.shadowRoot.querySelector("ha-card");
        if (hc) return hc;
      }
      // parfois la carte renvoie déjà un ha-card
      if (el && el.tagName && el.tagName.toLowerCase() === "ha-card") return el;
      return null;
    }

    _addOverlayInside(targetHaCard, { showBadge, badgeText, opacity, showLock }) {
      // container overlay
      const overlay = document.createElement("div");
      overlay.style.position = "absolute";
      overlay.style.inset = "0";
      overlay.style.zIndex = "10";
      overlay.style.cursor = "not-allowed";
      overlay.style.background = `rgba(0,0,0,${opacity || 0})`;

      // s'assurer que ha-card est positionné
      const computed = getComputedStyle(targetHaCard);
      if (computed.position === "static" || !computed.position) {
        targetHaCard.style.position = "relative";
      }

      const stop = e => { e.stopPropagation(); e.preventDefault(); };
      [
        "click","mousedown","mouseup","touchstart","touchend","pointerdown",
        "pointerup","change","input","keydown","keyup","contextmenu"
      ].forEach(ev => {
        const handler = (e) => stop(e);
        overlay.addEventListener(ev, handler, true);
        this._cleanup.push(() => overlay.removeEventListener(ev, handler, true));
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

    async _build() {
      // cleanup précédent
      this.disconnectedCallback();

      this._built = true;
      const root = this.shadowRoot;
      root.innerHTML = "";

      const innerCard = await createInnerCard(this._config.card, this._hass);
      this._innerCard = innerCard;
      root.appendChild(innerCard); // on insère la carte telle quelle

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

      const editing = this._isEditMode();

      // si autorisé : rien à bloquer, mais on peut afficher le badge si demandé
      if (isAllowed) {
        if (this._config.show_user) {
          const hc = this._findHaCard(innerCard);
          if (hc) {
            this._addOverlayInside(hc, {
              showBadge: true,
              badgeText: `Utilisateur: ${user.name || "(inconnu)"}`,
              opacity: 0,       // pas de voile
              showLock: false   // pas de cadenas
            });
          } else {
            // fallback : petit badge au-dessus (rare)
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

      // non autorisé : lecture seule
      if (!editing) {
        const hc = this._findHaCard(innerCard);
        if (hc) {
          this._addOverlayInside(hc, {
            showBadge: this._config.show_user,
            badgeText: `Utilisateur: ${user.name || "(inconnu)"}`,
            opacity: this._config.overlay_opacity,
            showLock: true
          });
        } else {
          // Fallback si pas de ha-card interne : on re-utilise un wrapper
          const wrapper = document.createElement("div");
          wrapper.style.position = "relative";
          wrapper.style.display = "block";
          root.insertBefore(wrapper, innerCard);
          root.removeChild(innerCard);
          wrapper.appendChild(innerCard);

          const overlay = document.createElement("div");
          overlay.style.position = "absolute";
          overlay.style.inset = "0";
          overlay.style.zIndex = "10";
          overlay.style.cursor = "not-allowed";
          overlay.style.background = `rgba(0,0,0,${this._config.overlay_opacity || 0})`;
          const stop = e => { e.stopPropagation(); e.preventDefault(); };
          ["click","mousedown","mouseup","touchstart","touchend","pointerdown","pointerup","change","input","keydown","keyup","contextmenu"].forEach(ev =>
            overlay.addEventListener(ev, stop, true)
          );
          const lockEl = document.createElement("div");
          lockEl.textContent = "🔒";
          lockEl.style.position = "absolute";
          lockEl.style.top = "8px";
          lockEl.style.right = "8px";
          lockEl.style.fontSize = "14px";
          lockEl.style.opacity = "0.6";
          overlay.appendChild(lockEl);

          if (this._config.show_user) {
            const badge = document.createElement("div");
            badge.textContent = `Utilisateur: ${user.name || "(inconnu)"}`;
            badge.style.position = "absolute";
            badge.style.left = "10px";
            badge.style.bottom = "6px";
            badge.style.fontSize = "12px";
            badge.style.opacity = "0.72";
            badge.style.pointerEvents = "none";
            badge.style.userSelect = "none";
            overlay.appendChild(badge);
          }

          wrapper.appendChild(overlay);
        }
      }
      // en mode édition: pas d'overlay => tu peux bouger/redimensionner
    }
  }

  if (!customElements.get("restrictor-card"))
    customElements.define("restrictor-card", RestrictorCard);
})();
