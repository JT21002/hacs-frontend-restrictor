// Restrictor Card — v0.3 (debug-friendly)
// - Affiche un hui-error-card lisible en cas d'erreur (helpers, /api/user, config...)
// - Fonctionne même sans helpers (fallback simple)
// - Overlay qui bloque 100% des interactions pour read_only
// - Logs console pour diagnostic

(function () {
  const TAG = "restrictor-card";

  function log(...args) {
    // Commente cette ligne si tu ne veux pas de logs
    console.info(`[${TAG}]`, ...args);
  }

  function makeErrorCard(message, origConfig) {
    const el = document.createElement("hui-error-card");
    try {
      el.setConfig({ type: "error", error: message, origConfig: origConfig || {} });
    } catch (e) {
      // fallback ultime
      const c = document.createElement("ha-card");
      c.style.padding = "12px";
      c.style.color = "var(--error-color, #db4437)";
      c.textContent = `Restrictor Card: ${message}`;
      return c;
    }
    return el;
  }

  async function getUserSafe() {
    try {
      const r = await fetch("/api/user");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json(); // { id, name, ... }
    } catch (e) {
      log("Erreur /api/user:", e);
      return { id: null, name: "", is_admin: false };
    }
  }

  async function createInnerCard(config, hass) {
    // Essaie avec les helpers
    try {
      const helpers = window.loadCardHelpers ? await window.loadCardHelpers() : null;
      if (helpers && helpers.createCardElement) {
        const card = helpers.createCardElement(config);
        card.hass = hass;
        return card;
      }
    } catch (e) {
      log("Helpers indisponibles ou createCardElement a échoué:", e);
    }
    // Fallback: error card descriptive
    const fallback = makeErrorCard("Helpers non disponibles. Vérifie Ressources Lovelace et cache navigateur.", config);
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
      if (!config || !config.card) {
        throw new Error('Restrictor Card: il manque la clé "card" dans la config.');
      }
      this._config = {
        allowed_users: Array.isArray(config.allowed_users) ? config.allowed_users.map(String) : [],
        mode: config.mode || (config.read_only ? "read_only" : "read_only"), // read_only | hidden
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
        try { this._innerCard.hass = hass; } catch (_) {}
      }
    }

    getCardSize() {
      if (this._innerCard && typeof this._innerCard.getCardSize === "function") {
        return this._innerCard.getCardSize();
      }
      return 3;
    }

    async _build() {
      this._built = true;
      const root = this.shadowRoot;
      root.innerHTML = "";

      // Crée la carte interne
      const innerCard = await createInnerCard(this._config.card, this._hass);
      this._innerCard = innerCard;

      // Récupère l'utilisateur
      const user = await getUserSafe();
      const userName = (user && user.name) ? String(user.name) : "";
      const allowed = this._config.allowed_users;
      const isAllowed = allowed.length === 0 || allowed.includes(userName);

      log("Utilisateur vu par la carte:", userName, "— Autorisé:", isAllowed);

      // Badge user (debug)
      if (this._config.show_user) {
        const badge = document.createElement("div");
        badge.textContent = `Utilisateur: ${userName || "(inconnu)"}`;
        badge.style.fontSize = "12px";
        badge.style.opacity = "0.7";
        badge.style.margin = "4px 8px";
        root.appendChild(badge);
      }

      if (isAllowed) {
        // Affiche simplement la carte
        root.appendChild(innerCard);
        return;
      }

      if (this._config.mode === "hidden") {
        // Masque complètement
        this.style.display = "none";
        return;
      }

      // Mode read_only: wrapper + overlay bloquant
      const wrapper = document.createElement("ha-card");
      wrapper.style.position = "relative";
      wrapper.style.display = "block";
      wrapper.appendChild(innerCard);

      const overlay = document.createElement("div");
      overlay.style.position = "absolute";
      overlay.style.inset = "0";
      overlay.style.zIndex = "10";
      overlay.style.cursor = "not-allowed";
      overlay.style.background = `rgba(0,0,0,${this._config.overlay_opacity})`;

      // Bloque tous les events d'interaction
      const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
      ["click","mousedown","mouseup","touchstart","touchend","pointerdown","pointerup","change","input","keydown","keyup","contextmenu"].forEach(ev =>
        overlay.addEventListener(ev, stop, true)
      );

      // Petit cadenas visuel
      const lock = document.createElement("div");
      lock.textContent = "🔒";
      lock.style.position = "absolute";
      lock.style.top = "8px";
      lock.style.right = "8px";
      lock.style.fontSize = "14px";
      lock.style.opacity = "0.6";
      overlay.appendChild(lock);

      wrapper.appendChild(overlay);
      root.appendChild(wrapper);
    }
  }

  if (!customElements.get("restrictor-card")) {
    customElements.define("restrictor-card", RestrictorCard);
    log("déclaré.");
  } else {
    log("déjà déclaré (hot reload).");
  }
})();
