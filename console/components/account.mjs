import { t } from "../i18n/index.mjs";
import { Widget, register, h, icon, button, closeButton, field, select } from "./base.mjs";
import "../.framework/components/xtoggle.js";
import "../vendor/xdrawer.mjs";
export function appearance(vm) {
  return h(
    "div",
    { class: "appearance-controls" },
    h(
      "fieldset",
      { class: "palette-picker" },
      h("legend", {}, t("Farbfamilie")),
      [
        ["slate", t("Slate")],
        ["black", t("Schwarz")],
        ["green", t("Waldgrün")],
        ["wine", t("Weinrot")],
      ].map(([value, label]) =>
        h(
          "label",
          { class: "palette-option" },
          h("input", {
            type: "radio",
            name: "palette",
            value,
            checked: (vm.palette || "slate") === value,
            "data-palette": true,
          }),
          h("span", { class: "palette-swatch " + value, "aria-hidden": true }),
          h("span", {}, label),
        ),
      ),
    ),
    h(
      "x-toggle",
      {
        label: t("Dunkles Farbschema"),
        checked: vm.theme === "dark",
        disabled: vm.themeMode === "system",
        "data-appearance-toggle": true,
      },
      h("span", { slot: "on-label" }, t("Ein")),
      h("span", { slot: "off-label" }, t("Aus")),
    ),
    h(
      "label",
      { class: "check" },
      h("input", {
        type: "checkbox",
        checked: vm.themeMode === "system",
        "data-auto-theme": true,
      }),
      t("Automatisch"),
    ),
    h(
      "p",
      { class: "muted small" },
      vm.themeMode === "system"
        ? t("Folgt der Systemeinstellung.")
        : t("Deine Auswahl wird im Profil gespeichert."),
    ),
  );
}
export function bindAppearance(widget) {
  const opts = { signal: widget.controller.signal };
  widget.shadowRoot.addEventListener(
    "toggle-changed",
    (e) => {
      if (e.target.matches("[data-high-contrast]"))
        widget.emit("highContrast", String(e.detail.checked));
      if (e.target.matches("[data-appearance-toggle]"))
        widget.emit("themeSet", String(e.detail.checked));
    },
    opts,
  );
  widget.shadowRoot.addEventListener(
    "change",
    (e) => {
      if (e.target.matches("[data-palette]"))
        widget.emit("palette", e.target.value);
      if (e.target.matches("[data-language]"))
        widget.emit("language", e.target.value);
      if (e.target.matches("[data-auto-language]"))
        widget.emit("languageAuto", String(e.target.checked));
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
          "aria-label": t("Benachrichtigungen"),
        },
        h(
          "div",
          { class: "panel-heading" },
          h("h2", {}, t("Benachrichtigungen")),
          h(
            "div",
            { class: "notification-tools" },
            items.length
              ? button(
                  t("Alle löschen"),
                  "clearNotifications",
                  "",
                  "",
                  "text-btn small",
                )
              : null,
            closeButton("closeNotifications", t("Benachrichtigungen schließen")),
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
                      "aria-label":
                        t("Benachrichtigung schließen: ") + n.message,
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
              h("strong", {}, t("Alles erledigt")),
              h(
                "p",
                {},
                this.vm.user.profile?.updateNotifications === false
                  ? t(
                      "Update-Benachrichtigungen sind in deinem Profil deaktiviert.",
                    )
                  : t("Keine neuen Update-Benachrichtigungen."),
              ),
            ),
        h(
          "p",
          { class: "muted small notification-footer" },
          t("Geschlossene Meldungen bleiben für dein Konto ausgeblendet."),
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
          label: t("Dein Profil"),
          open: vm.profileOpen,
          "data-theme": vm.theme,
        },
        h("strong", { slot: "header" }, t("Dein Profil")),
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
          field(t("Anzeigename"), "displayName", p.displayName, "text", {
            required: true,
            maxlength: 80,
            autocomplete: "nickname",
          }),
          select(t("Profil-Icon"), "avatar", p.avatar, [
            ["initials", t("Initialen")],
            ["user", t("Person")],
            ["shield", t("Schild")],
            ["cube", t("Container")],
            ["cloud", t("Cloud")],
          ]),
          h(
            "p",
            { class: "muted small" },
            t(
              "Deine Rolle und Host-Berechtigungen werden vom Administrator verwaltet.",
            ),
          ),
          h("h3", {}, t("Darstellung")),
          appearance(vm),
          h("h3", {}, t("Benachrichtigungen")),
          h(
            "label",
            { class: "check" },
            h("input", {
              type: "checkbox",
              name: "updateNotifications",
              checked: p.updateNotifications !== false,
            }),
            t("Update-Benachrichtigungen anzeigen"),
          ),
          h(
            "button",
            { type: "submit", class: "btn primary full" },
            t("Profil speichern"),
          ),
        ),
        h(
          "div",
          { slot: "footer", class: "profile-footer" },
          button(t("Abmelden"), "logout", "", "", "text-btn"),
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
      h("h3", {}, t("OpenID Connect")),
      h(
        "span",
        { class: "badge " + (vm.oidc?.enabled ? "good" : "muted") },
        vm.oidc?.enabled ? t("Aktiviert") : t("Nicht aktiviert"),
      ),
      h(
        "p",
        { class: "muted" },
        t("Der Owner kann einen beliebigen OIDC-Provider konfigurieren."),
      ),
    );
  return h(
    "article",
    { class: "policy-card oidc-card" },
    h(
      "div",
      { class: "panel-heading" },
      h("h3", {}, t("OpenID Connect")),
      h(
        "span",
        { class: "badge " + (c.enabled ? "good" : "muted") },
        c.enabled ? t("Aktiviert") : t("Nicht aktiviert"),
      ),
    ),
    h(
      "p",
      { class: "muted" },
      t(
        "Verbinde CUO mit deinem OIDC-Provider. Registriere dort einen Web-Client mit Authorization Code Flow und PKCE (S256).",
      ),
    ),
    h(
      "label",
      { class: "field" },
      h("span", {}, t("Redirect-URI für den Provider")),
      h("input", {
        readonly: true,
        value: c.redirectUri,
        "aria-label": t("Redirect-URI"),
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
        t("SSO-Anmeldung aktivieren"),
      ),
      h(
        "label",
        { class: "check" },
        h("input", {
          name: "localLoginEnabled",
          type: "checkbox",
          checked: c.localLoginEnabled !== false,
        }),
        t("Lokale Anmeldung mit Benutzername und Passwort erlauben"),
      ),
      h(
        "p",
        { class: "callout small" },
        t(
          "Ohne lokale Anmeldung zeigt der Login nur SSO; auch der Passwort-Endpunkt wird gesperrt. Aktiviere dies erst nach einem erfolgreichen SSO-Test. Bei Provider-Ausfall und für lokale Owner-Konten lässt sich der Zugang ausschließlich über das Host-Terminal wiederherstellen: ./tools/recover-login.sh. Bestehende Sitzungen bleiben gültig.",
        ),
      ),
      field(t("Beschriftung der Anmeldung"), "label", c.label, "text", {
        maxlength: 80,
      }),
      field(t("Issuer-URL"), "issuer", c.issuer, "url", {
        placeholder: "https://identity.example.org",
        maxlength: 2048,
      }),
      field(
        t("Discovery-URL (optional)"),
        "discoveryUrl",
        c.discoveryUrl,
        "url",
        {
          placeholder:
            "https://identity.example.org/.well-known/openid-configuration",
          maxlength: 2048,
        },
      ),
      field(t("Client-ID"), "clientId", c.clientId, "text", {
        maxlength: 500,
        autocomplete: "off",
      }),
      field(
        c.secretConfigured
          ? t("Client-Secret (gespeichert; leer lassen zum Beibehalten)")
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
        t("Gespeichertes Client-Secret entfernen"),
      ),
      select(t("Client-Authentifizierung"), "authMethod", c.authMethod, [
        ["client_secret_post", t("Client-Secret im Request-Body")],
        ["client_secret_basic", t("HTTP Basic")],
        ["none", t("Öffentlicher Client (PKCE)")],
      ]),
      field(t("Scopes"), "scope", c.scope, "text", {
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
        t("Neue SSO-Benutzer automatisch anlegen"),
      ),
      select(t("Rolle für neue SSO-Benutzer"), "defaultRole", c.defaultRole, [
        ["Viewer", "Viewer"],
        ["Operator", "Operator"],
        ["Administrator", "Administrator"],
      ]),
      h(
        "p",
        { class: "callout" },
        t(
          "Bei automatischer Anlage erhalten alle vom Provider zugelassenen Benutzer diese Rolle auf dem lokalen Host. Bestehende Rollen werden beibehalten.",
        ),
      ),
      h(
        "button",
        { type: "submit", class: "btn primary" },
        t("Speichern und Verbindung prüfen"),
      ),
    ),
  );
}
