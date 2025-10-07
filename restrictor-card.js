// Restrictor Card — v0.6
// - Comparaison utilisateur insensible à la casse (toujours)
// - allowed_users et allowed_ids
// - hass.user prioritaire, fallback /api/user
// - Badge utilisateur affiché seulement si show_user: true

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
      return await r.json();
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
        allowed_ids: Array.isArray(config.allowed_ids) ? config.allowed_ids : [],
        mode: config.mode || (config.read_only ? "read_only" : "read_only"),
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

    async _build() {
      this._built = true;
      const root = this.shadowRoot;
      root.innerHTML = "";

      const innerCard = await createInnerCard(this._config.card, this._hass);
      this._innerCard = innerCard;

      // besoin d'infos utilisateur ?
      const needUser =
        this._config.show_user ||
        this._config.allowed_users.length > 0 ||
        this._config.allowed_ids.length > 0;

      let user = { id: "", name: "" };
      if (needUser) user = await this._getCurrentUser();

      // autorisation
      let isAllowed = true;
      if (this._config.allowed_users.length > 0 || this._config.allowed_ids.length > 0) {
        const uname = this._norm(user.name);
        const uid = this._norm(user.id);
        const names = this._config.allowed_users.map(x => this._norm(x));
        const ids = this._config.allowed_ids.map(x => this._norm(x));
        isAllowed = names.includes(uname) || ids.includes(uid);
      }

      // badge utilisateur si demandé
      if (this._config.show_user) {
        const badge = document.createElement("div");
        badge.textContent = `Utilisateur: ${user.name || "(inconnu)"} — id: ${user.id || "(?)"}`;
        badge.style.fontSize = "12px";
        badge.style.opacity = "0.7";
        badge.style.margin = "4px 8px";
        root.appendChild(badge);
      }

      // rendu
      if (isAllowed) {
        root.appendChild(innerCard);
        return;
      }

      if (this._config.mode === "hidden") {
        this.style.display = "none";
        return;
      }

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

      const stop = e => { e.stopPropagation(); e.preventDefault(); };
      [
        "click","mousedown","mouseup","touchstart","touchend","pointerdown",
        "pointerup","change","input","keydown","keyup","contextmenu"
      ].forEach(ev => overlay.addEventListener(ev, stop, true));

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

  if (!customElements.get("restrictor-card"))
    customElements.define("restrictor-card", RestrictorCard);
})();
