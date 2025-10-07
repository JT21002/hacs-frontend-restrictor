class RestrictorCard extends HTMLElement {
  setConfig(config) {
    this._config = config;
  }

  async connectedCallback() {
    const user = await this._getUser();
    const allowedUsers = this._config.allowed_users || [];
    const readOnly = this._config.read_only || false;

    if (allowedUsers.includes(user.name)) {
      this.innerHTML = `<ha-card>${this._config.content}</ha-card>`;
    } else if (readOnly) {
      this.innerHTML = `<ha-card style="pointer-events:none;opacity:0.5;">${this._config.content}</ha-card>`;
    } else {
      this.style.display = "none";
    }
  }

  async _getUser() {
    const resp = await fetch("/api/user");
    return await resp.json(); // { id, name, is_admin }
  }

  set hass(hass) {
    this._hass = hass;
  }
}

customElements.define('restrictor-card', RestrictorCard);
