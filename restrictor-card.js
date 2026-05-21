// Restrictor Card — v1.5
// - hui-card-picker monté sur document.body (overlay) pour éviter l'isolation shadowRoot
// - Suppression de l'éditeur YAML inline
// - Users via WebSocket
// - Tous les fixes v1.1

const RESTRICTOR_VERSION = "1.5.0";
try {
  const KEY  = "restrictor_card_version";
  const prev = localStorage.getItem(KEY);
  if (prev && prev !== RESTRICTOR_VERSION) {
    const fire = () => { try { window.dispatchEvent(new Event("ll-reload-resources")); } catch {} };
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", () => setTimeout(fire, 500))
      : setTimeout(fire, 1000);
  }
  localStorage.setItem(KEY, RESTRICTOR_VERSION);
} catch {}

(function () {

  // ── Helpers partagés ────────────────────────────────────────────────────────

  async function getCurrentUser(hass) {
    try {
      const u = hass?.user;
      if (u && (u.name || u.id)) return { id: u.id || "", name: u.name || "" };
      const r = await fetch("/api/user", { credentials: "same-origin" });
      if (!r.ok) throw new Error();
      return await r.json();
    } catch { return { id: "", name: "" }; }
  }

  async function fetchAllUsers(hass) {
    try {
      const result = await hass.connection.sendMessagePromise({ type: "config/auth/list" });
      const list   = Array.isArray(result) ? result : (result?.result ?? []);
      return list.filter(u =>
        u.is_active !== false &&
        u.system_generated !== true &&
        Array.isArray(u.credentials) && u.credentials.length > 0
      );
    } catch { return []; }
  }

  function makeErrorCard(message, origConfig) {
    const el = document.createElement("hui-error-card");
    try { el.setConfig({ type: "error", error: message, origConfig: origConfig || {} }); return el; }
    catch {
      const c = document.createElement("ha-card");
      c.style.cssText = "padding:12px;color:var(--error-color,#db4437)";
      c.textContent   = `Restrictor Card: ${message}`;
      return c;
    }
  }

  async function createInnerCard(config, hass) {
    try {
      const helpers = window.loadCardHelpers ? await window.loadCardHelpers() : null;
      if (helpers?.createCardElement) {
        const card = helpers.createCardElement(config);
        card.hass  = hass;
        return card;
      }
    } catch {}
    return makeErrorCard("Helpers non disponibles — vider le cache (Ctrl+F5).", config);
  }

  function esc(str) {
    return String(str ?? "").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
  }

  function getLovelace() {
    try {
      return document.querySelector("home-assistant")?.shadowRoot
        ?.querySelector("ha-panel-lovelace")?.shadowRoot
        ?.querySelector("hui-root")?.lovelace ?? null;
    } catch { return null; }
  }

  // ── Overlay picker (monté sur document.body) ─────────────────────────────

  function openCardPicker(hass, onPick) {
    // Crée un vrai <dialog> natif → entre dans le top layer comme le dialog HA
    const nativeDialog = document.createElement("dialog");
    Object.assign(nativeDialog.style, {
      border:        "none",
      padding:       "0",
      borderRadius:  "12px",
      width:         "min(720px, 95vw)",
      maxHeight:     "85vh",
      overflow:      "hidden",
      background:    "var(--card-background-color, #1c1c1c)",
      boxShadow:     "0 8px 32px rgba(0,0,0,0.5)",
      display:       "flex",
      flexDirection: "column",
    });
    // Backdrop via ::backdrop CSS — injecté dans <head>
    if (!document.getElementById("restrictor-dialog-style")) {
      const style = document.createElement("style");
      style.id = "restrictor-dialog-style";
      style.textContent = `
        dialog#restrictor-card-picker-dialog::backdrop {
          background: rgba(0,0,0,0.6);
        }
        dialog#restrictor-card-picker-dialog {
          display: flex;
          flex-direction: column;
        }
      `;
      document.head.appendChild(style);
    }
    nativeDialog.id = "restrictor-card-picker-dialog";

    // Header
    const header = document.createElement("div");
    Object.assign(header.style, {
      display:        "flex",
      alignItems:     "center",
      justifyContent: "space-between",
      padding:        "16px 20px",
      borderBottom:   "1px solid var(--divider-color,#333)",
      flexShrink:     "0",
    });
    header.innerHTML = `
      <span style="font-size:16px;font-weight:600;color:var(--primary-text-color)">Choisir une carte</span>
      <button id="rcp-close" style="background:none;border:none;cursor:pointer;font-size:20px;color:var(--secondary-text-color);padding:4px 8px;border-radius:4px;">✕</button>
    `;
    nativeDialog.appendChild(header);

    // Picker
    const body = document.createElement("div");
    Object.assign(body.style, { flex:"1", overflow:"auto", minHeight:"300px" });
    const picker = document.createElement("hui-card-picker");
    picker.hass     = hass;
    picker.lovelace = getLovelace();
    body.appendChild(picker);
    nativeDialog.appendChild(body);

    document.body.appendChild(nativeDialog);
    nativeDialog.showModal();

    const close = () => {
      nativeDialog.close();
      try { document.body.removeChild(nativeDialog); } catch {}
    };

    // Clic sur le backdrop (outside dialog)
    nativeDialog.addEventListener("click", (e) => {
      const rect = nativeDialog.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top  || e.clientY > rect.bottom) close();
    });
    header.querySelector("#rcp-close").addEventListener("click", close);
    nativeDialog.addEventListener("cancel", close);

    const onPickEvent = (e) => {
      const cfg = e.detail?.config || e.detail?.cardConfig || e.detail;
      if (!cfg || typeof cfg !== "object" || !cfg.type) return;
      close();
      onPick(cfg);
    };
    ["config-changed","card-picked","pick-card","value-changed"].forEach(ev => {
      picker.addEventListener(ev, onPickEvent);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ÉDITEUR
  // ═══════════════════════════════════════════════════════════════════════════

  class RestrictorCardEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._config = {};
      this._hass   = null;
      this._users  = [];
      this._ready  = false;
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._ready) this._init();
    }

    setConfig(config) {
      this._config = { ...config };
      if (this._ready) this._render();
    }

    async _init() {
      this._ready = true;
      this._users = await fetchAllUsers(this._hass);
      this._render();
    }

    _fire(newConfig) {
      this.dispatchEvent(new CustomEvent("config-changed", {
        detail: { config: newConfig }, bubbles: true, composed: true,
      }));
    }

    _render() {
      const cfg          = this._config;
      const allowedUsers = Array.isArray(cfg.allowed_users) ? cfg.allowed_users : [];
      const mode         = cfg.mode || "read_only";
      const opacity      = typeof cfg.overlay_opacity === "number" ? cfg.overlay_opacity : 0;
      const showUser     = !!cfg.show_user;
      const gridRows     = cfg.grid_options?.rows    ?? cfg.grid_rows    ?? "";
      const gridCols     = cfg.grid_options?.columns ?? cfg.grid_columns ?? "";
      const currentType  = cfg.card?.type || "";

      const userOptions = this._users.length > 0
        ? this._users.map(u =>
            `<option value="${esc(u.name)}" ${allowedUsers.includes(u.name) ? "selected":""}>` +
            `${esc(u.name)}${u.is_owner ? " 👑" : u.is_admin ? " (admin)":""}</option>`
          ).join("")
        : `<option disabled>Aucun utilisateur trouvé</option>`;

      this.shadowRoot.innerHTML = `
        <style>
          :host { display:block; font-family:var(--paper-font-body1_-_font-family,sans-serif); }
          .section { margin-bottom:16px; }
          .section-title {
            font-size:13px; font-weight:600; color:var(--secondary-text-color);
            text-transform:uppercase; letter-spacing:.05em; margin-bottom:10px;
          }
          .row { display:flex; align-items:center; gap:12px; margin-bottom:10px; }
          .row label { flex:0 0 160px; font-size:14px; color:var(--primary-text-color); }
          select, input[type="number"], input[type="range"] {
            flex:1; padding:6px 8px; border-radius:6px;
            border:1px solid var(--divider-color,#e0e0e0);
            background:var(--card-background-color,#fff);
            color:var(--primary-text-color); font-size:14px;
          }
          select[multiple] { min-height:90px; padding:4px; }
          select[multiple] option { padding:5px 8px; border-radius:4px; cursor:pointer; }
          select[multiple] option:checked { background:var(--primary-color,#03a9f4); color:#fff; }
          .hint { font-size:11px; color:var(--secondary-text-color); margin:-4px 0 8px 172px; }
          .toggle-row { display:flex; align-items:center; justify-content:space-between; padding:6px 0; }
          .toggle-row label { font-size:14px; color:var(--primary-text-color); }
          .opacity-row { display:flex; align-items:center; gap:12px; margin-bottom:10px; }
          .opacity-row label { flex:0 0 160px; font-size:14px; color:var(--primary-text-color); }
          .opacity-val { font-size:13px; color:var(--secondary-text-color); min-width:34px; text-align:right; }
          hr { border:none; border-top:1px solid var(--divider-color,#e0e0e0); margin:16px 0; }

          .card-badge {
            display:flex; align-items:center; gap:10px; padding:10px 14px;
            background:var(--secondary-background-color,rgba(255,255,255,.04));
            border:1px solid var(--divider-color,#e0e0e0); border-radius:8px;
          }
          .card-badge-type { flex:1; font-size:13px; font-weight:600; color:var(--primary-text-color); }
          .change-btn {
            background:none; border:none; cursor:pointer; padding:4px 10px;
            color:var(--primary-color,#03a9f4); font-size:13px;
            border-radius:4px; font-weight:500;
          }
          .change-btn:hover { background:rgba(3,169,244,.1); }
          .add-card-btn {
            display:flex; align-items:center; justify-content:center; gap:8px;
            width:100%; padding:14px; border-radius:8px; cursor:pointer;
            border:2px dashed var(--divider-color,#ccc);
            background:transparent; color:var(--primary-color,#03a9f4);
            font-size:14px; font-weight:500; box-sizing:border-box;
          }
          .add-card-btn:hover { background:rgba(3,169,244,.07); border-color:var(--primary-color,#03a9f4); }
        </style>

        <!-- Carte à protéger -->
        <div class="section">
          <div class="section-title">Carte à protéger</div>
          <div id="card-zone">
            ${currentType
              ? `<div class="card-badge">
                   <span style="font-size:18px">🃏</span>
                   <span class="card-badge-type">${esc(currentType)}</span>
                   <button class="change-btn" id="change-btn">Changer</button>
                 </div>`
              : `<button class="add-card-btn" id="add-card-btn">
                   <span style="font-size:20px;line-height:1">＋</span> Choisir une carte
                 </button>`
            }
          </div>
        </div>

        <hr>

        <!-- Contrôle d'accès -->
        <div class="section">
          <div class="section-title">Contrôle d'accès</div>
          <div class="row">
            <label>Utilisateurs autorisés</label>
            <select id="allowed-users" multiple>${userOptions}</select>
          </div>
          <div class="hint">Ctrl+clic pour plusieurs. Vide = tout le monde.</div>

          <div class="row" style="margin-top:8px">
            <label>Mode</label>
            <select id="mode">
              <option value="read_only" ${mode==="read_only"?"selected":""}>🔒 Lecture seule</option>
              <option value="hidden"    ${mode==="hidden"   ?"selected":""}>👁️ Cachée</option>
            </select>
          </div>

          <div class="opacity-row" id="opacity-row" style="${mode==="hidden"?"opacity:.4;pointer-events:none":""}">
            <label>Opacité du verrou</label>
            <input type="range" id="opacity" min="0" max="0.6" step="0.05" value="${opacity}">
            <span class="opacity-val" id="opacity-val">${Math.round(opacity*100)}%</span>
          </div>
        </div>

        <hr>

        <!-- Affichage -->
        <div class="section">
          <div class="section-title">Affichage</div>
          <div class="toggle-row">
            <label>Afficher le nom de l'utilisateur connecté</label>
            <ha-switch id="show-user" ${showUser?"checked":""}></ha-switch>
          </div>
        </div>

        <hr>

        <!-- Mise en page -->
        <div class="section">
          <div class="section-title">Mise en page (vue Sections)</div>
          <div class="row">
            <label>Lignes</label>
            <input type="number" id="grid-rows" min="1" max="12" value="${gridRows}" placeholder="auto">
          </div>
          <div class="row">
            <label>Colonnes</label>
            <input type="number" id="grid-cols" min="1" max="12" value="${gridCols}" placeholder="auto">
          </div>
          <div class="hint">Laisser vide = taille automatique.</div>
        </div>
      `;

      this._attachListeners();
    }

    _openPicker() {
      openCardPicker(this._hass, (cardConfig) => {
        const newConfig = { ...this._config, card: cardConfig };
        this._config    = newConfig;
        this._fire(newConfig);
        this._render();
      });
    }

    _attachListeners() {
      const r = this.shadowRoot;

      r.getElementById("add-card-btn")?.addEventListener("click", () => this._openPicker());
      r.getElementById("change-btn")?.addEventListener("click",   () => this._openPicker());

      r.getElementById("allowed-users")?.addEventListener("change", (e) => {
        const selected  = Array.from(e.target.selectedOptions).map(o => o.value);
        const newConfig = { ...this._config, allowed_users: selected };
        this._config = newConfig; this._fire(newConfig);
      });

      r.getElementById("mode")?.addEventListener("change", (e) => {
        const newMode = e.target.value;
        const opRow   = r.getElementById("opacity-row");
        if (opRow) { opRow.style.opacity = newMode==="hidden"?"0.4":"1"; opRow.style.pointerEvents = newMode==="hidden"?"none":""; }
        const newConfig = { ...this._config, mode: newMode };
        this._config = newConfig; this._fire(newConfig);
      });

      const opInput = r.getElementById("opacity");
      const opVal   = r.getElementById("opacity-val");
      opInput?.addEventListener("input",  (e) => { if (opVal) opVal.textContent = `${Math.round(parseFloat(e.target.value)*100)}%`; });
      opInput?.addEventListener("change", (e) => {
        const newConfig = { ...this._config, overlay_opacity: parseFloat(e.target.value) };
        this._config = newConfig; this._fire(newConfig);
      });

      r.getElementById("show-user")?.addEventListener("change", (e) => {
        const newConfig = { ...this._config, show_user: e.target.checked };
        this._config = newConfig; this._fire(newConfig);
      });

      r.getElementById("grid-rows")?.addEventListener("change", (e) => {
        const val = parseInt(e.target.value);
        const go  = { ...(this._config.grid_options||{}) };
        if (!isNaN(val)&&val>0) go.rows=val; else delete go.rows;
        const newConfig = { ...this._config, grid_options: go };
        this._config = newConfig; this._fire(newConfig);
      });

      r.getElementById("grid-cols")?.addEventListener("change", (e) => {
        const val = parseInt(e.target.value);
        const go  = { ...(this._config.grid_options||{}) };
        if (!isNaN(val)&&val>0) go.columns=val; else delete go.columns;
        const newConfig = { ...this._config, grid_options: go };
        this._config = newConfig; this._fire(newConfig);
      });
    }
  }

  if (!customElements.get("restrictor-card-editor")) {
    customElements.define("restrictor-card-editor", RestrictorCardEditor);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CARTE PRINCIPALE
  // ═══════════════════════════════════════════════════════════════════════════

  class RestrictorCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._hass          = null;
      this._config        = null;
      this._innerCard     = null;
      this._built         = false;
      this._evtCleanup    = [];
      this._editObserver  = null;
      this._domObserver   = null;
      this._visHandlers   = [];
      this._debounceTimer = null;
      this._userCache     = null;
      this._userCacheKey  = null;
      this._lastLockState = null;
    }

    static getConfigElement() { return document.createElement("restrictor-card-editor"); }

    static getStubConfig() {
      return { card: null, allowed_users: [], mode: "read_only", overlay_opacity: 0, show_user: false };
    }

    setConfig(config) {
      if (!config?.card) {
        this._config = { allowed_users: [], mode: "read_only", overlay_opacity: 0, show_user: false, card: null };
        return;
      }
      let mode = config.mode === "hidden" ? "hidden" : "read_only";
      this._config = {
        allowed_users:   Array.isArray(config.allowed_users) ? config.allowed_users : [],
        mode,
        overlay_opacity: typeof config.overlay_opacity === "number" ? config.overlay_opacity : 0,
        show_user:       !!config.show_user,
        view_layout:     config.view_layout,
        grid_options:    config.grid_options,
        grid_rows:       config.grid_rows   ?? config.rows,
        grid_columns:    config.grid_columns ?? config.columns,
        card:            config.card,
      };
      this._built = false;
      this._lastLockState = null;
      if (this._hass) this._build();
    }

    set hass(hass) {
      this._hass = hass;
      const u   = hass?.user;
      const key = u ? `${u.id}|${u.name}` : null;
      if (key !== this._userCacheKey) { this._userCache = null; this._userCacheKey = key; }
      if (!this._built && this._config?.card) { this._build(); return; }
      if (this._innerCard && this._innerCard.hass !== hass) {
        try { this._innerCard.hass = hass; } catch {}
      }
      this._scheduleReapply();
    }

    disconnectedCallback() { this._reset(); }

    _reset() {
      this._clearOverlays();
      if (this._editObserver) { try { this._editObserver.disconnect(); } catch {} this._editObserver = null; }
      if (this._domObserver)  { try { this._domObserver.disconnect();  } catch {} this._domObserver  = null; }
      this._detachVisibilityHooks();
      this._cancelDebounce();
      this._lastLockState = null;
    }

    getLayoutOptions() {
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
      if (this._config?.view_layout) return {};
      if (this._innerCard && typeof this._innerCard.getLayoutOptions === "function") {
        try { return this._innerCard.getLayoutOptions() ?? {}; } catch {}
      }
      return {};
    }

    getCardSize() { return this._innerCard?.getCardSize?.() ?? 3; }
    _norm(s) { return String(s ?? "").trim().toLowerCase(); }

    async _getCurrentUser() {
      if (this._userCache) return this._userCache;
      this._userCache = await getCurrentUser(this._hass);
      return this._userCache;
    }

    _isEditMode() {
      if (this._hass && typeof this._hass.editMode === "boolean") return this._hass.editMode;
      if (document.body.classList.contains("edit-mode")) return true;
      try {
        const huiRoot = document.querySelector("home-assistant")?.shadowRoot
          ?.querySelector("ha-panel-lovelace")?.shadowRoot?.querySelector("hui-root");
        const view = huiRoot?.shadowRoot?.querySelector("hui-view, hui-sectioned-view");
        return !!(view?.classList?.contains("edit-mode") || view?.hasAttribute?.("edit-mode"));
      } catch { return false; }
    }

    _watchEditMode() {
      if (this._editObserver) return;
      let last = this._isEditMode();
      this._editObserver = new MutationObserver(() => {
        const now = this._isEditMode();
        if (now !== last) { last = now; this._scheduleReapply(); }
      });
      this._editObserver.observe(document.body, { attributes:true, subtree:true, attributeFilter:["class"] });
    }

    _attachDomObserver() {
      const sr = this._innerCard?.shadowRoot;
      if (!sr) return;
      if (this._domObserver) { try { this._domObserver.disconnect(); } catch {} }
      this._domObserver = new MutationObserver(() => this._scheduleReapply());
      this._domObserver.observe(sr, { childList:true, subtree:true });
    }

    _attachVisibilityHooks() {
      const h = () => this._scheduleReapply();
      document.addEventListener("visibilitychange", h);
      window.addEventListener("location-changed",   h);
      window.addEventListener("popstate",           h);
      window.addEventListener("hashchange",         h);
      this._visHandlers = [
        () => document.removeEventListener("visibilitychange", h),
        () => window.removeEventListener("location-changed",   h),
        () => window.removeEventListener("popstate",           h),
        () => window.removeEventListener("hashchange",         h),
      ];
    }

    _detachVisibilityHooks() { this._visHandlers.forEach(fn => { try { fn(); } catch {} }); this._visHandlers = []; }
    _cancelDebounce() { if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; } }

    _scheduleReapply() {
      this._cancelDebounce();
      this._debounceTimer = setTimeout(async () => {
        this._debounceTimer = null;
        try { await this._applyLockState(); } catch {}
      }, 150);
    }

    _findAllHaCards(el) {
      const out = new Set(), seen = new Set();
      const crawl = (node, d) => {
        if (!node || seen.has(node) || d > 4) return;
        seen.add(node);
        if (node.tagName?.toLowerCase() === "ha-card") out.add(node);
        if (node.shadowRoot) {
          node.shadowRoot.querySelectorAll("ha-card").forEach(hc => out.add(hc));
          node.shadowRoot.querySelectorAll("*").forEach(child => crawl(child, d+1));
        }
      };
      crawl(el, 0);
      return Array.from(out);
    }

    _clearOverlays() {
      [this._innerCard?.shadowRoot, this.shadowRoot].filter(Boolean).forEach(root => {
        root.querySelectorAll(".restrictor-overlay").forEach(n => { try { n.parentElement?.removeChild(n); } catch {} });
      });
      this._evtCleanup.forEach(fn => { try { fn(); } catch {} });
      this._evtCleanup = [];
    }

    _addOverlayInside(targetHaCard, { showBadge, badgeText, opacity, showLock, interactive }) {
      const overlay = document.createElement("div");
      overlay.className = "restrictor-overlay";
      Object.assign(overlay.style, {
        position:"absolute", inset:"0", zIndex:"10",
        cursor:        interactive ? "default"  : "not-allowed",
        background:    `rgba(0,0,0,${opacity||0})`,
        pointerEvents: interactive ? "none"     : "auto",
      });
      const cs = getComputedStyle(targetHaCard);
      if (!cs.position || cs.position === "static") targetHaCard.style.position = "relative";
      if (!interactive) {
        const stop = e => { e.stopPropagation(); e.preventDefault(); };
        ["click","mousedown","mouseup","touchstart","touchend",
         "pointerdown","pointerup","change","input","keydown","keyup","contextmenu"
        ].forEach(ev => {
          const h = e => stop(e);
          overlay.addEventListener(ev, h, true);
          this._evtCleanup.push(() => overlay.removeEventListener(ev, h, true));
        });
        if (showLock) {
          const lock = document.createElement("div");
          lock.textContent = "🔒";
          Object.assign(lock.style, { position:"absolute", top:"8px", right:"8px", fontSize:"14px", opacity:"0.6" });
          overlay.appendChild(lock);
        }
      }
      if (showBadge) {
        const badge = document.createElement("div");
        badge.textContent = badgeText;
        Object.assign(badge.style, {
          position:"absolute", top:"8px", left:"10px", fontSize:"11px", opacity:"0.85",
          pointerEvents:"none", userSelect:"none", background:"rgba(0,0,0,0.45)",
          color:"#fff", padding:"2px 6px", borderRadius:"4px", lineHeight:"1.4",
        });
        overlay.appendChild(badge);
      }
      targetHaCard.appendChild(overlay);
      this._evtCleanup.push(() => { try { targetHaCard.removeChild(overlay); } catch {} });
    }

    async _applyLockState() {
      if (!this._innerCard) return;
      this._clearOverlays();
      this.style.display = "";
      const needUser = this._config.show_user || this._config.allowed_users.length > 0;
      let user = { id: "", name: "" };
      if (needUser) user = await this._getCurrentUser();
      let isAllowed = true;
      if (this._config.allowed_users.length > 0) {
        const uname = this._norm(user.name);
        isAllowed = this._config.allowed_users.some(x => this._norm(x) === uname);
      }
      if (this._isEditMode()) { this._lastLockState = "edit"; return; }
      if (isAllowed) {
        this._lastLockState = "allowed";
        if (this._config.show_user) {
          const first = this._findAllHaCards(this._innerCard)[0];
          if (first) this._addOverlayInside(first, {
            showBadge:true, badgeText:user.name||"(inconnu)",
            opacity:0, showLock:false, interactive:true,
          });
        }
        return;
      }
      if (this._config.mode === "hidden") {
        this._lastLockState = "hidden"; this.style.display = "none"; return;
      }
      this._lastLockState = "locked";
      this._findAllHaCards(this._innerCard).forEach((hc, idx) => {
        this._addOverlayInside(hc, {
          showBadge:   this._config.show_user && idx === 0,
          badgeText:   user.name || "(inconnu)",
          opacity:     this._config.overlay_opacity,
          showLock:    true, interactive: false,
        });
      });
    }

    async _build() {
      this._reset();
      this._built = true;
      this.shadowRoot.innerHTML = "";
      const inner = await createInnerCard(this._config.card, this._hass);
      this._innerCard = inner;
      this.shadowRoot.appendChild(inner);
      this._watchEditMode();
      this._attachDomObserver();
      this._attachVisibilityHooks();
      try { await this._applyLockState(); } catch {}
      setTimeout(async () => { try { await this._applyLockState(); } catch {} }, 300);
    }
  }

  if (!customElements.get("restrictor-card")) {
    customElements.define("restrictor-card", RestrictorCard);
  }

})();

// Enregistrement HA — requis pour getConfigElement()
window.customCards = window.customCards || [];
if (!window.customCards.some(c => c.type === "restrictor-card")) {
  window.customCards.push({
    type:        "restrictor-card",
    name:        "Restrictor Card",
    description: "Restreint l'accès à une carte selon l'utilisateur connecté.",
    preview:     false,
  });
}