// Restrictor Card — v0.10.1
// - Comme v0.10 mais gère les stacks (horizontal/vertical/grid) : overlay sur TOUS les <ha-card> enfants
// - Overlay OFF en mode édition (compat. Sections)
// - Filtrage par NOM d’utilisateur (insensible à la casse)
// - Badge utilisateur (nom) seulement si show_user: true

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

    // --- NOUVEAU: récupère TOUS les <ha-card> descendants (stack-safe) ---
    _findAllHaCards(el) {
      const out = new Set();

      // 1) ha-card direct dans le shadowRoot de la carte
      if (el?.shadowRoot) {
        el.shadowRoot.querySelectorAll("ha-card").forEach(hc => out.add(hc));
      }

      // 2) si la carte est un "stack", ses enfants sont d'autres cartes
      //    on descend de 2 niveaux max pour éviter de tout traverser coûteusement
      const scanCards = (node, depth = 0) => {
        if (!node || depth > 2) return;
        const sr = node.shadowRoot;
        if (sr) {
          sr.querySelectorAll("ha-card").forEach(hc => out.add(hc));
          // descend vers d'autres custom elements potentiels
          sr.querySelectorAll("*").forEach(child => {
            if (child.shadowRoot) scanCards(child, depth + 1);
          });
        }
      };
      scanCards(el, 0);

      // 3) fallback: si el est déjà un ha-card
      if (el && el.tagName && el.tagName.toLowerCase() === "ha-card") out.add(el);

      return Array.from(out);
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

      if (isAllowed) {
        if (this._config.show_user) {
          // Ajoute un badge discret sur le PREMIER ha-card trouvé (s'il y en a)
          const cards = this._findAllHaCards(innerCard);
          const hc = cards[0];
          if (hc) {
            this._addOverlayInside(hc, {
              showBadge: true,
              badgeText: `Utilisateur: ${user.name || "(inconnu)"}`,
              opacity: 0,
              showLock: false
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

      if (!editing) {
        // 🔒 NON AUTORISÉ : overlay sur TOUTES les sous-cartes
        const cards = this._findAllHaCards(innerCard);
        if (cards.length === 0) return; // rien trouvé (rare)
        cards.forEach((hc, idx) => {
          this._addOverlayInside(hc, {
            showBadge: !!this._config.show_user && idx === 0, // badge sur la 1ère carte seulement
            badgeText: `Utilisateur: ${user.name || "(inconnu)"}`,
            opacity: this._config.overlay_opacity,
            showLock: true
          });
        });
      }
      // En édition → aucun overlay (mise en page OK).
    }
  }

  if (!customElements.get("restrictor-card"))
    customElements.define("restrictor-card", RestrictorCard);
})();
