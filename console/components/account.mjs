import { Widget, register, h, icon, button, field, select } from "./base.mjs";
import "../.framework/components/xtoggle.js";
import "../vendor/xdrawer.mjs";
export function appearance(vm) {
  return h(
    "div",
    { class: "appearance-controls" },
    h("x-toggle", {
      label: "Dunkles Farbschema",
      checked: vm.theme === "dark",
      disabled: vm.themeMode === "system",
      "data-appearance-toggle": true,
    }),
    h(
      "label",
      { class: "check" },
      h("input", {
        type: "checkbox",
        checked: vm.themeMode === "system",
        "data-auto-theme": true,
      }),
      "Automatisch",
    ),
    h(
      "p",
      { class: "muted small" },
      vm.themeMode === "system"
        ? "Folgt der Systemeinstellung."
        : "Deine Auswahl wird im Profil gespeichert.",
    ),
  );
}
export function bindAppearance(widget) {
  const opts = { signal: widget.controller.signal };
  widget.shadowRoot.addEventListener(
    "toggle-changed",
    (e) => {
      if (e.target.matches("[data-appearance-toggle]"))
        widget.emit("themeSet", String(e.detail.checked));
    },
    opts,
  );
  widget.shadowRoot.addEventListener(
    "change",
    (e) => {
      if (e.target.matches("[data-auto-theme]"))
        widget.emit("themeAuto", String(e.target.checked));
    },
    opts,
  );
}
export class XNotificationCenter extends Widget {
  connectedCallback() {
    super.connectedCallback();
    const opts = { signal: this.controller.signal };
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (
          this.vm.notificationsOpen &&
          !e
            .composedPath()
            .some((n) => n === this || n?.id === "cuo-notifications-trigger")
        )
          this.emit("closeNotifications");
      },
      opts,
    );
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && this.vm.notificationsOpen) {
          e.preventDefault();
          this.emit("closeNotifications");
          document.getElementById("cuo-notifications-trigger")?.focus();
        }
      },
      opts,
    );
  }
  render() {
    if (!this.vm.notificationsOpen) return [];
    const items = this.vm.notifications || [];
    return [
      h(
        "section",
        {
          class: "notification-center",
          role: "region",
          "aria-label": "Benachrichtigungen",
        },
        h(
          "div",
          { class: "panel-heading" },
          h("h2", {}, "Benachrichtigungen"),
          h(
            "div",
            { class: "notification-tools" },
            items.length
              ? button(
                  "Alle löschen",
                  "clearNotifications",
                  "",
                  "",
                  "text-btn small",
                )
              : null,
            h(
              "button",
              {
                type: "button",
                class: "icon-btn",
                "aria-label": "Benachrichtigungen schließen",
                "data-kind": "closeNotifications",
              },
              icon("x"),
            ),
          ),
        ),
        items.length
          ? h(
              "div",
              { class: "notification-list" },
              items.map((n) =>
                h(
                  "article",
                  { class: "notification-item " + n.tone, key: n.id },
                  h(
                    "span",
                    { class: "notification-symbol" },
                    icon(
                      n.tone === "success" ? "check" : "bell",
                      n.tone === "success" ? "core" : "cuo",
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      class: "notification-link",
                      "data-kind": "navigate",
                      "data-value": n.page,
                    },
                    h("strong", {}, n.title),
                    h("span", {}, n.message),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      class: "icon-btn",
                      "aria-label": "Benachrichtigung schließen: " + n.message,
                      "data-kind": "dismissNotification",
                      "data-id": n.id,
                    },
                    icon("x"),
                  ),
                ),
              ),
            )
          : h(
              "div",
              { class: "notification-empty" },
              icon("check"),
              h("strong", {}, "Alles erledigt"),
              h(
                "p",
                {},
                this.vm.user.profile?.updateNotifications === false
                  ? "Update-Benachrichtigungen sind in deinem Profil deaktiviert."
                  : "Keine neuen Update-Benachrichtigungen.",
              ),
            ),
        h(
          "p",
          { class: "muted small notification-footer" },
          "Geschlossene Meldungen bleiben für dein Konto ausgeblendet.",
        ),
      ),
    ];
  }
}
register("x-cuo-notifications", XNotificationCenter);
export class XProfileDrawer extends Widget {
  connectedCallback() {
    super.connectedCallback();
    bindAppearance(this);
    this.shadowRoot.addEventListener(
      "drawer-closed",
      () => {
        if (this.vm.profileOpen) this.emit("closeProfile");
      },
      { signal: this.controller.signal },
    );
  }
  render() {
    const vm = this.vm,
      p = vm.user.profile || {
        displayName: vm.user.name,
        avatar: "initials",
        updateNotifications: true,
      };
    return [
      h(
        "x-drawer",
        {
          id: "cuo-profile-drawer",
          placement: "right",
          modal: true,
          label: "Dein Profil",
          open: vm.profileOpen,
          "data-theme": vm.theme,
        },
        h("strong", { slot: "header" }, "Dein Profil"),
        h(
          "form",
          { "data-form": "saveProfile", class: "profile-form" },
          h(
            "div",
            { class: "profile-summary" },
            h(
              "span",
              { class: "profile-avatar" },
              p.avatar === "initials" ? vm.userInitials : icon(p.avatar, "cuo"),
            ),
            h(
              "div",
              {},
              h("h2", {}, vm.user.name),
              h("span", { class: "badge blue" }, vm.user.role),
            ),
          ),
          field("Anzeigename", "displayName", p.displayName, "text", {
            required: true,
            maxlength: 80,
            autocomplete: "nickname",
          }),
          select("Profil-Icon", "avatar", p.avatar, [
            ["initials", "Initialen"],
            ["user", "Person"],
            ["shield", "Schild"],
            ["cube", "Container"],
            ["cloud", "Cloud"],
          ]),
          h(
            "p",
            { class: "muted small" },
            "Deine Rolle und Host-Berechtigungen werden vom Administrator verwaltet.",
          ),
          h("h3", {}, "Darstellung"),
          appearance(vm),
          h("h3", {}, "Benachrichtigungen"),
          h(
            "label",
            { class: "check" },
            h("input", {
              type: "checkbox",
              name: "updateNotifications",
              checked: p.updateNotifications !== false,
            }),
            "Update-Benachrichtigungen anzeigen",
          ),
          h(
            "button",
            { type: "submit", class: "btn primary full" },
            "Profil speichern",
          ),
        ),
        h(
          "div",
          { slot: "footer", class: "profile-footer" },
          button("Schließen", "closeProfile", "", "", "btn"),
          button("Abmelden", "logout", "", "", "text-btn"),
        ),
      ),
    ];
  }
  submit(form) {
    const data = Object.fromEntries(new FormData(form));
    data.updateNotifications = form.elements.updateNotifications.checked;
    data.theme = this.vm.themeMode;
    this.emit("saveProfile", "", "", data);
  }
}
register("x-cuo-profile", XProfileDrawer);
export function oidcSettings(vm) {
  const c = vm.oidcConfig;
  if (!c)
    return h(
      "article",
      { class: "policy-card" },
      h("h3", {}, "OpenID Connect"),
      h(
        "span",
        { class: "badge " + (vm.oidc?.enabled ? "good" : "muted") },
        vm.oidc?.enabled ? "Aktiviert" : "Nicht aktiviert",
      ),
      h(
        "p",
        { class: "muted" },
        "Der Owner kann einen beliebigen OIDC-Provider konfigurieren.",
      ),
    );
  return h(
    "article",
    { class: "policy-card oidc-card" },
    h(
      "div",
      { class: "panel-heading" },
      h("h3", {}, "OpenID Connect"),
      h(
        "span",
        { class: "badge " + (c.enabled ? "good" : "muted") },
        c.enabled ? "Aktiviert" : "Nicht aktiviert",
      ),
    ),
    h(
      "p",
      { class: "muted" },
      "Verbinde CUO mit deinem OIDC-Provider. Registriere dort einen Web-Client mit Authorization Code Flow und PKCE (S256).",
    ),
    h(
      "label",
      { class: "field" },
      h("span", {}, "Redirect-URI für den Provider"),
      h("input", {
        readonly: true,
        value: c.redirectUri,
        "aria-label": "Redirect-URI",
        class: "redirect-uri",
      }),
    ),
    h(
      "form",
      { "data-form": "saveOIDC", class: "oidc-form" },
      h(
        "label",
        { class: "check" },
        h("input", { name: "enabled", type: "checkbox", checked: c.enabled }),
        "SSO-Anmeldung aktivieren",
      ),
      field("Beschriftung der Anmeldung", "label", c.label, "text", {
        maxlength: 80,
      }),
      field("Issuer-URL", "issuer", c.issuer, "url", {
        placeholder: "https://identity.example.org",
        maxlength: 2048,
      }),
      field("Discovery-URL (optional)", "discoveryUrl", c.discoveryUrl, "url", {
        placeholder:
          "https://identity.example.org/.well-known/openid-configuration",
        maxlength: 2048,
      }),
      field("Client-ID", "clientId", c.clientId, "text", {
        maxlength: 500,
        autocomplete: "off",
      }),
      field(
        c.secretConfigured
          ? "Client-Secret (gespeichert; leer lassen zum Beibehalten)"
          : "Client-Secret",
        "clientSecret",
        "",
        "password",
        { maxlength: 4096, autocomplete: "new-password" },
      ),
      h(
        "label",
        { class: "check" },
        h("input", { name: "clearSecret", type: "checkbox" }),
        "Gespeichertes Client-Secret entfernen",
      ),
      select("Client-Authentifizierung", "authMethod", c.authMethod, [
        ["client_secret_post", "Client-Secret im Request-Body"],
        ["client_secret_basic", "HTTP Basic"],
        ["none", "Öffentlicher Client (PKCE)"],
      ]),
      field("Scopes", "scope", c.scope, "text", {
        required: true,
        maxlength: 500,
      }),
      h(
        "label",
        { class: "check" },
        h("input", {
          name: "autoProvision",
          type: "checkbox",
          checked: c.autoProvision,
        }),
        "Neue SSO-Benutzer automatisch anlegen",
      ),
      select("Rolle für neue SSO-Benutzer", "defaultRole", c.defaultRole, [
        ["Viewer", "Viewer"],
        ["Operator", "Operator"],
        ["Administrator", "Administrator"],
      ]),
      h(
        "p",
        { class: "callout" },
        "Bei automatischer Anlage erhalten alle vom Provider zugelassenen Benutzer diese Rolle auf dem lokalen Host. Bestehende Rollen werden beibehalten. Die lokale Anmeldung bleibt verfügbar.",
      ),
      h(
        "button",
        { type: "submit", class: "btn primary" },
        "Speichern und Verbindung prüfen",
      ),
    ),
  );
}
