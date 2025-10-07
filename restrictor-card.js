// Restrictor Card — v0.16
// - L’éditeur de mise en page (view Sections) a la priorité totale
// - Si l’éditeur n’a rien défini, on relaie la taille de la carte interne (getLayoutOptions), sinon on ne renvoie rien
// - Verrou lecture seule sur toutes les sous-cartes (stacks), overlay désactivé en mode édition
// - Filtrage par NOM d’utilisateur (insensible à la casse)
// - Badge utilisateur (nom) seulement si show_user: true

(function () {

  async function getUserFromApi() {
    try { const r = await fetch("/api/user", { credentials: "same-origin" }); if (!r.ok) throw new Error(); return await r.json(); }
    catch { return { id: "", name: "" }; }
  }

  function makeErrorCard(message, cfg) {
    const el = document.createElement("hui-error-card");
    try { el.setConfig({ type: "error", error: message, origConfig: cfg || {} }); return el; }
    catch { const c=document.createElement("ha-card"); c.style.padding="12px"; c.style.color="var(--error-color,#db4437)"; c.textContent=`Restrictor Card: ${message}`; return c; }
  }

  async function createInnerCard(config, hass) {
    try {
      const helpers = window.loadCardHelpers ? await window.loadCardHelpers() : null;
      if (helpers?.createCardElement) { const card = helpers.createCardElement(config); card.hass = hass; return card; }
    } catch {}
    const fallback = makeErrorCard("Helpers non disponibles. Vérifie la ressource et vide le cache.", config);
    fallback.hass = hass; return fallback;
  }

  class RestrictorCard extends HTMLElement {
    constructor() {
      super(); this.attachShadow({ mode: "open" });
      this._hass=null; this._config=null; this._innerCard=null; this._built=false;
      this._cleanup=[]; this._editObserver=null; this._lastEdit=false;
      this._userCache=null;
    }

    setConfig(config) {
      if (!config || !config.card) throw new Error('Restrictor Card: il manque la clé "card".');
      this._config = {
        allowed_users: Array.isArray(config.allowed_users) ? config.allowed_users : [],
        mode: config.mode || (config.read_only ? "read_only" : "read_only"),   // "read_only" | "hidden"
        overlay_opacity: typeof config.overlay_opacity === "number" ? config.overlay_opacity : 0.0,
        show_user: !!config.show_user,
        // 👇 stocke ce que l’éditeur a mis (l’UI écrit cette clé sur la carte parente)
        view_layout: config.view_layout,    // <-- PRIORITÉ À L’ÉDITEUR
        card: config.card,
      };
      this._built=false; if (this._hass) this._build();
    }

    set hass(hass) {
      this._hass=hass;
      if (!this._built && this._config) this._build();
      if (this._innerCard && this._innerCard.hass !== hass) { try { this._innerCard.hass = hass; } catch {} }
    }

    disconnectedCallback() {
      this._cleanup.forEach(u=>{try{u();}catch{}}); this._cleanup=[];
      if (this._editObserver) { try{this._editObserver.disconnect();}catch{} } this._editObserver=null;
    }

    // ---------- Mise en page (Sections) ----------
    // 1) Si l’éditeur a défini view_layout -> on ne renvoie rien (HA utilisera l’override)
    // 2) Sinon, on délègue à la carte interne si elle sait répondre
    getLayoutOptions() {
      if (this._config?.view_layout) return undefined; // laisser l’éditeur décider
      if (this._innerCard?.getLayoutOptions) {
        try { return this._innerCard.getLayoutOptions(); } catch {}
      }
      return undefined; // pas de valeur par défaut forcée
    }

    getCardSize() { return this._innerCard?.getCardSize?.() ?? 3; }
    _norm(s){ return String(s ?? "").trim().toLowerCase(); }

    async _getCurrentUser() {
      if (this._userCache) return this._userCache;
      const u = this._hass?.user; if (u && (u.name || u.id)) { this._userCache = { id:u.id||"", name:u.name||"" }; return this._userCache; }
      this._userCache = await getUserFromApi(); return this._userCache;
    }

    _isEditMode(){
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

    _watchEditMode(){
      const target=document.body; if (!target || this._editObserver) return;
      this._lastEdit=this._isEditMode();
      this._editObserver=new MutationObserver(()=>{ const now=this._isEditMode(); if(now!==this._lastEdit){ this._lastEdit=now; this._applyLockState(); }});
      this._editObserver.observe(target,{attributes:true,subtree:true,attributeFilter:["class"]});
    }

    _findAllHaCards(el){
      const out=new Set(), seen=new Set();
      const crawl=(n,d=0)=>{ if(!n||seen.has(n)||d>5) return; seen.add(n);
        if(n.shadowRoot){ n.shadowRoot.querySelectorAll("ha-card").forEach(h=>out.add(h));
          n.shadowRoot.querySelectorAll("*").forEach(c=>crawl(c,d+1)); }
      };
      crawl(el,0);
      if (el && el.tagName?.toLowerCase()==="ha-card") out.add(el);
      return Array.from(out);
    }

    _clearOverlays(){
      const root = this._innerCard?.shadowRoot || this.shadowRoot;
      if (!root) return;
      root.querySelectorAll(".restrictor-overlay").forEach(n=>{try{n.parentElement.removeChild(n);}catch{}});
      this._cleanup.forEach(u=>{try{u();}catch{}}); this._cleanup=[];
    }

    _addOverlayInside(targetHaCard,{showBadge,badgeText,opacity,showLock}){
      const overlay=document.createElement("div");
      overlay.className="restrictor-overlay";
      overlay.style.position="absolute"; overlay.style.inset="0"; overlay.style.zIndex="10";
      overlay.style.cursor="not-allowed"; overlay.style.background=`rgba(0,0,0,${opacity||0})`;
      const cs=getComputedStyle(targetHaCard);
      if (!cs.position || cs.position==="static") targetHaCard.style.position="relative";
      const stop=e=>{ e.stopPropagation(); e.preventDefault(); };
      ["click","mousedown","mouseup","touchstart","touchend","pointerdown","pointerup","change","input","keydown","keyup","contextmenu"]
        .forEach(ev=>{ const h=e=>stop(e); overlay.addEventListener(ev,h,true); this._cleanup.push(()=>overlay.removeEventListener(ev,h,true)); });
      if (showLock){ const l=document.createElement("div"); l.textContent="🔒"; l.style.position="absolute"; l.style.top="8px"; l.style.right="8px"; l.style.fontSize="14px"; l.style.opacity="0.6"; overlay.appendChild(l); }
      if (showBadge){ const b=document.createElement("div"); b.textContent=badgeText; b.style.position="absolute"; b.style.left="10px"; b.style.bottom="6px"; b.style.fontSize="12px"; b.style.opacity="0.72"; b.style.pointerEvents="none"; b.style.userSelect="none"; overlay.appendChild(b); }
      targetHaCard.appendChild(overlay);
      this._cleanup.push(()=>{try{targetHaCard.removeChild(overlay);}catch{}});
    }

    async _applyLockState(){
      if (!this._innerCard) return;
      this._clearOverlays();

      // autorisation
      let user={id:"",name:""}; const needUser=!!this._config.show_user || (this._config.allowed_users?.length>0);
      if (needUser) user = await this._getCurrentUser();

      let isAllowed = true;
      if (this._config.allowed_users?.length>0) {
        const uname=this._norm(user.name); const names=this._config.allowed_users.map(x=>this._norm(x));
        isAllowed = names.includes(uname);
      }

      const editing = this._isEditMode();
      if (editing) return; // pas d’overlay pendant l’édition (curseurs OK)

      if (isAllowed) {
        if (this._config.show_user) {
          const first = this._findAllHaCards(this._innerCard)[0];
          if (first) this._addOverlayInside(first,{showBadge:true,badgeText:`Utilisateur: ${user.name||"(inconnu)"}`,opacity:0,showLock:false});
        }
        return;
      }

      if (this._config.mode === "hidden") { this.style.display="none"; return; }

      // non autorisé → overlay sur chaque sous-carte
      this._findAllHaCards(this._innerCard).forEach((hc,idx)=>{
        this._addOverlayInside(hc,{
          showBadge: !!this._config.show_user && idx===0,
          badgeText: `Utilisateur: ${user.name||"(inconnu)"}`,
          opacity: this._config.overlay_opacity,
          showLock: true
        });
      });
    }

    async _build(){
      this.disconnectedCallback(); // reset watchers
      this._built=true; this._userCache=null;

      const root=this.shadowRoot; root.innerHTML="";
      const inner=await createInnerCard(this._config.card,this._hass);
      this._innerCard=inner; root.appendChild(inner);

      this._watchEditMode();
      await this._applyLockState();
    }
  }

  if (!customElements.get("restrictor-card")) customElements.define("restrictor-card", RestrictorCard);
})();
