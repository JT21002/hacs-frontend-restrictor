// Restrictor Card — v0.2
// Contrôle l'affichage / l'interactivité d'une carte selon l'utilisateur connecté.

class RestrictorCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._card = null;
    this._user = null;
  }

  setConfig(config) {
    if (!config || !config.card) {
      throw new Error('Restrictor Card: il manque la clé "card" dans la config.');
    }
    this._config = {
      mode: config.read_only ? "read_only" : (config.mode || "read_only"),
      allowed_users: config.allowed_users || [],
      hide_when_denied: config.mode === "hidden" || config.hide === true,
      show_user_badge: config.show_user === true,
      card: config.card,
      overlay_opacity: typeof config.overlay_opacity === "number" ? config.overlay_opacity : 0.0
    };
    // (Re)construire si hass est déjà disponible
    if (this._hass) this._build();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._card) {
      // propage le hass si la carte est déjà créée
      try { this._card.hass = hass; } catch (_) {}
    } else if (this._config) {
      this._build();
    }
  }

  getCardSize() {
    // délègue à la carte interne si possible
    if (this._card && typeof this._card.getCardSize === "function") {
      return this._card.getCardSize();
    }
    return 3;
  }

  async _getUser() {
    if (this._user) return this._user;
    const resp = await fetch("/api/user");
    if (!resp.ok) throw new Error("Restrictor Card: impossible de récupérer l'utilisateur.");
    this._user = await resp.json(); // { id, name, is_admin, ... }
    return this._user;
  }

  async _build() {
    const root = this.shadowRoot;
    root.innerHTML = "";

    // Crée la carte cible
    const helpers = (window.loadCardHelpers) ? await window.loadCardHelpers() : null;
    let innerCard;
    if (helpers && helpers.createCardElement) {
      innerCard = helpers.createCardElement(this._config.card);
    } else {
      innerCard = document.createElement("hui-error-card");
      innerCard.setConfig({
        type: "error",
        error: "Helpers non disponibles",
        origConfig: this._config.card
      });
    }
    innerCard.hass = this._hass;

    // Récupère l’utilisateur courant
    const user = await this._getUser();
    const userName = (user && user.name) ? String(user.name) : "";
    const allowed = this._config.allowed_users.map(String);
    const isAllowed = allowed.length === 0 || allowed.includes(userName);

    // Badge utilisateur (optionnel, utile pour debug)
    if (this._config.show_user_badge) {
      const badge = document.createElement("div");
      badge.textContent = `Utilisateur: ${userName}`;
      badge.style.fontSize = "12px";
      badge.style.opacity = "0.7";
      badge.style.margin = "4px 0 0 8px";
      root.appendChild(badge);
    }

    if (isAllowed) {
      // Autorisé : on affiche la carte telle quelle
      this._card = innerCard;
      root.appendChild(innerCard);
      return;
    }

    // Non autorisé :
    if (this._config.mode === "hidden" || this._config.hide_when_denied) {
      // Masquer complètement
      this.style.display = "none";
      return;
    }

    // Lecture seule : on affiche la carte mais on bloque l’interaction via un overlay
    const wrapper = document.createElement("ha-card");
    wrapper.style.position = "relative";
    wrapper.appendChild(innerCard);

    const overlay = document.createElement("div");
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.zIndex = "10";
    overlay.style.cursor = "not-allowed";
    // Optionnel: léger voile pour indiquer le verrou
    overlay.style.background = `rgba(0,0,0,${this._config.overlay_opacity})`;

    // Bloque toute interaction
    const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
    ["click","mousedown","mouseup","touchstart","touchend","pointerdown","pointerup","change","input","keydown","keyup"].forEach(ev =>
      overlay.addEventListener(ev, stop, true)
    );

    // Ajoute un petit cadenas (visuel doux)
    const lock = document.createElement("div");
    lock.style.position = "absolute";
    lock.style.right = "8px";
    lock.style.top = "8px";
    lock.style.fontSize = "14px";
    lock.style.opacity = "0.6";
    lock.textContent = "🔒";
    overlay.appendChild(lock);

    wrapper.appendChild(overlay);
    this._card = innerCard;
    root.appendChild(wrapper);
  }
}

customElements.define("restrictor-card", RestrictorCard);

