import { t } from "../i18n/index.mjs";
import { workspaceSettings, bindSettingsTabs } from "./workspace-settings.mjs";
import { appearance, bindAppearance, oidcSettings } from "./account.mjs";
import { executableCandidates } from "./update-candidates.mjs";
import { loadNotices, tutorial } from "./help.mjs";
import {
  Widget,
  register,
  h,
  icon,
  button,
  field,
  select,
  modeLabel,
  stageLabel,
  formatDate,
} from "./base.mjs";
const can = (vm, cap) =>
  vm.user?.role === "Owner" || (vm.capabilities || []).includes(cap);
const bool = (data) => data === "on" || data === "true";
export class XCUOAuth extends Widget {
  render() {
    const vm = this.vm,
      enroll = vm.auth === "enroll";
    return [
      h(
        "section",
        { class: "auth-card" },
        h(
          "div",
          { class: "auth-brand" },
          h("span", { class: "cube-mark" }, icon("cube", "cuo")),
          h("strong", {}, "CUO"),
          h("span", { class: "muted" }, "v0.3.0"),
        ),
        h("p", { class: "eyebrow" }, t("CONTAINER UPDATE ORCHESTRATOR")),
        h(
          "h1",
          {},
          vm.auth === "loading"
            ? t("CUO wird gestartet …")
            : enroll
              ? t("Deinen Workspace einrichten")
              : t("Willkommen zurück"),
        ),
        h(
          "p",
          { class: "muted" },
          enroll
            ? t(
                "Lege den ersten lokalen Administrator an. Deine Daten bleiben auf diesem Host.",
              )
            : t("Melde dich an, um deine Container zu verwalten."),
        ),
        vm.auth === "loading" ||
          (!enroll && vm.oidc?.localLoginEnabled === false)
          ? null
          : h(
              "form",
              { "data-form": enroll ? "enroll" : "login" },
              field(t("Benutzername"), "name", "", "text", {
                required: true,
                autocomplete: "username",
                minlength: 3,
                maxlength: 80,
              }),
              field(t("Passwort"), "password", "", "password", {
                required: true,
                autocomplete: enroll ? "new-password" : "current-password",
                minlength: 12,
                maxlength: 256,
              }),
              enroll
                ? h(
                    "p",
                    { class: "muted small" },
                    t(
                      "Mindestens 12 Zeichen. Das Konto erhält die Rolle Owner.",
                    ),
                  )
                : null,
              h(
                "button",
                { class: "btn primary full", type: "submit" },
                enroll ? t("Administrator anlegen") : t("Anmelden"),
              ),
            ),
        !enroll && vm.oidc?.enabled
          ? button(
              String(vm.oidc.label || t("Mit SSO anmelden")),
              "oidcLogin",
              "",
              "",
              "btn full",
              "shield",
            )
          : null,
        h(
          "div",
          { class: "auth-footer" },
          icon("shield"),
          h("span", {}, t("Lokal installiert · sichere Sitzung")),
        ),
        button(t("Design-Demo ansehen"), "demo", "", "", "text-btn"),
      ),
    ];
  }
  submit(form) {
    this.emit(
      form.dataset.form,
      "",
      "",
      Object.fromEntries(new FormData(form)),
    );
  }
}
register("x-cuo-auth", XCUOAuth);
export class XApprovalDialog extends Widget {
  connectedCallback() {
    super.connectedCallback();
    for (const event of ["input", "change"])
      this.shadowRoot.addEventListener(
        event,
        (e) => {
          if (
            ["permissionReason", "permissionsConfirmed"].includes(e.target.name)
          )
            e.target.setCustomValidity("");
        },
        { signal: this.controller.signal },
      );
    this.shadowRoot.addEventListener(
      "cancel",
      (e) => {
        e.preventDefault();
        this.emit("close");
      },
      { signal: this.controller.signal, capture: true },
    );
  }
  update() {
    super.update();
    if (this.vm.dialog === "help" && !this.noticesState) {
      this.noticesState = "loading";
      loadNotices()
        .then((notices) => {
          this.notices = notices;
          this.noticesState = "ready";
        })
        .catch(() => {
          this.noticesState = "failed";
        })
        .finally(() => {
          if (this.isConnected && this.vm.dialog === "help") this.update();
        });
    }
    const dialog = this.content.querySelector("dialog");
    if (!dialog) return;
    if (this.vm.dialog && !dialog.open) {
      dialog.showModal();
      queueMicrotask(() =>
        dialog.querySelector("input,select,button")?.focus(),
      );
    } else if (!this.vm.dialog && dialog.open) dialog.close();
  }
  render() {
    const vm = this.vm,
      c = (vm.containers || []).find((c) => c.id === vm.selected),
      job = (vm.jobs || []).find((j) => j.id === vm.selected),
      policy = (vm.policies || []).find((p) => p.id === vm.selected);
    const kind = vm.dialog;
    if (kind === "process") return [];
    let title = "",
      body = [];
    if (kind === "help") {
      title = "CUO – Kurzanleitung & Lizenzen";
      body = tutorial(this.notices, this.noticesState);
    } else if (kind === "container") {
      title = c?.name || "Update-Lauf";
      body = c
        ? [
            h(
              "div",
              { class: "container-icon-preview" },
              h("x-container-icon", { image: c.image, theme: vm.theme }),
              h("span", {}, c.name),
            ),
            h(
              "nav",
              { class: "tabs", "aria-label": t("Container-Einstellungen") },
              [
                ["overview", t("Übersicht")],
                ["source", t("Image-Quelle")],
                ["permissions", t("Ausführungsrechte")],
              ].map(([value, label]) =>
                button(
                  label,
                  "containerTab",
                  value,
                  "",
                  "btn" +
                    (String(vm.containerTab || "overview") === value
                      ? " primary"
                      : ""),
                ),
              ),
            ),
            vm.containerTab === "source"
              ? h(
                  "section",
                  {},
                  h("h3", {}, t("Image-Quelle & Release-Zuordnung")),
                  h("p", { class: "break" }, c.image),
                  h(
                    "p",
                    { class: "break muted" },
                    c.localImage
                      ? t("Lokal gebautes Image ohne veröffentlichten Digest.")
                      : t(
                          "OCI-Registry; vorhandene Digest-Pins werden beachtet.",
                        ),
                  ),
                  c.candidate?.subscriptionId
                    ? h(
                        "div",
                        {},
                        h(
                          "p",
                          { class: "break" },
                          "Subscription: " + c.candidate.subscriptionId,
                        ),
                        h(
                          "p",
                          { class: "break" },
                          "Release-Set: " + c.candidate.releaseSetId,
                        ),
                        h(
                          "p",
                          { class: "break" },
                          "Ziel: " + (c.candidate.targetImage || c.image),
                        ),
                        button(
                          t("Subscriptions öffnen"),
                          "navigate",
                          "subscriptions",
                          "",
                          "btn",
                          "link",
                        ),
                      )
                    : h(
                        "p",
                        {},
                        t(
                          "Keine Release-Subscription zugeordnet. Die Registry-Verbindung wird anhand von Host und Repository ausgewählt.",
                        ),
                      ),
                  button(
                    t("Registries öffnen"),
                    "navigate",
                    "registries",
                    "",
                    "btn",
                    "cube",
                  ),
                )
              : vm.containerTab === "permissions"
                ? h(
                    "section",
                    {},
                    h("h3", {}, t("Wirksame Ausführungsrechte")),
                    h(
                      "p",
                      {},
                      "Verwaltungslabel: " +
                        (c.managed ? "cuo.managed=true" : "fehlt"),
                    ),
                    h(
                      "p",
                      {},
                      "Update-Modus: " + (modeLabel[c.mode] || c.mode),
                    ),
                    h(
                      "p",
                      { class: "callout small" },
                      t(
                        "Zusätzlicher Host-Monitoring-Zugriff benötigt eine ausdrückliche containerbezogene Richtlinie. Privilegierte Host-Aktionen und schreibende System-Mounts bleiben gesperrt.",
                      ),
                    ),
                    button(
                      t("Richtlinie & Freigabe bearbeiten"),
                      "policy",
                      "",
                      c.id,
                      "btn",
                      "shield",
                    ),
                  )
                : h(
                    "div",
                    { class: "detail-grid" },
                    [
                      [t("Image"), c.image],
                      [t("Plattform"), c.platform],
                      [t("Status"), c.state],
                      [t("Gruppe"), c.group],
                      [t("Richtlinie"), modeLabel[c.mode]],
                      [
                        t("Verwaltet"),
                        c.managed
                          ? "Ja"
                          : t("Nein – cuo.managed=true benötigt"),
                      ],
                      [
                        t("Compose"),
                        c.compose
                          ? t("Ja – registriertes Projekt benötigt")
                          : t("Nein"),
                      ],
                      [
                        "Update-Digest",
                        c.candidate?.targetDigest || t("Kein Update bekannt"),
                      ],
                      [t("Hinweis"), c.candidate?.error || c.reason || "–"],
                    ].map(([a, b]) =>
                      h(
                        "div",
                        {},
                        h("small", { class: "muted" }, a),
                        h("p", { class: "break" }, b),
                      ),
                    ),
                  ),
            h(
              "div",
              { class: "dialog-actions" },
              button(t("Richtlinie bearbeiten"), "policy", "", c.id, "btn"),
              button(
                t("Update planen"),
                "run",
                "",
                c.id,
                "btn primary",
                "play",
              ),
            ),
          ]
        : [
            h(
              "p",
              {},
              job
                ? stageLabel[job.state] || job.state
                : t("Eintrag ist nicht mehr im aktuellen Inventar vorhanden."),
            ),
          ];
    } else if (kind === "add") {
      title = t("Container hinzufügen");
      body = [
        h(
          "p",
          {},
          t(
            "CUO entdeckt Container auf dem lokalen Docker-Host automatisch. Die App erstellt keine beliebigen neuen Workloads.",
          ),
        ),
        h(
          "ol",
          { class: "instructions" },
          h("li", {}, t("Container mit Docker oder Compose anlegen.")),
          h("li", {}, t("Für Updates das Label cuo.managed=true setzen.")),
          h(
            "li",
            {},
            t("Inventar aktualisieren und eine Update-Richtlinie wählen."),
          ),
        ),
        h("code", { class: "code-block" }, 'labels:\n  cuo.managed: "true"'),
        h(
          "p",
          { class: "muted" },
          t(
            "Compose: zusätzlich cuo.compose.file relativ zum registrierten Projektverzeichnis setzen.",
          ),
        ),
        button(
          t("Inventar aktualisieren"),
          "discover",
          "",
          "",
          "btn primary",
          "refresh",
        ),
      ];
    } else if (kind === "windowDetails") {
      const window = (vm.windows || []).find((w) => w.id === vm.selected);
      title = t("Wartungsfenster");
      body = window
        ? [
            h("h3", {}, window.name),
            h(
              "div",
              { class: "detail-grid" },
              [
                [t("Start"), window.start + " Uhr"],
                [t("Dauer"), window.durationMinutes + " Minuten"],
                [t("Zeitzone"), window.timezone],
                [t("Status"), window.enabled ? t("Aktiv") : t("Deaktiviert")],
                [
                  t("Wochentage"),
                  window.days
                    .map(
                      (day) =>
                        [
                          t("So"),
                          t("Mo"),
                          t("Di"),
                          t("Mi"),
                          t("Do"),
                          t("Fr"),
                          t("Sa"),
                        ][day],
                    )
                    .join(", "),
                ],
                [t("Ausnahmen"), window.blackouts?.join(", ") || t("Keine")],
              ].map(([label, value]) =>
                h(
                  "div",
                  {},
                  h("small", { class: "muted" }, label),
                  h("p", {}, value),
                ),
              ),
            ),
            h(
              "p",
              { class: "callout" },
              t(
                "Laufende Jobs werden beim Fensterende nicht unterbrochen. Vergangene Fenster werden nicht nachgeholt.",
              ),
            ),
          ]
        : [h("p", {}, t("Wartungsfenster nicht mehr vorhanden."))];
    } else if (kind === "window") {
      title = t("Wartungsfenster erstellen");
      body = [
        h(
          "form",
          { "data-form": "saveWindow" },
          field(t("Name"), "name", t("Standard"), "text", {
            required: true,
            maxlength: 100,
          }),
          h(
            "div",
            { class: "form-grid" },
            field(t("Startzeit"), "start", "03:00", "time", { required: true }),
            field(t("Dauer in Minuten"), "durationMinutes", "60", "number", {
              min: 1,
              max: 1440,
              required: true,
            }),
          ),
          field(t("IANA-Zeitzone"), "timezone", "Europe/Berlin", "text", {
            required: true,
          }),
          h(
            "fieldset",
            {},
            h("legend", {}, t("Wochentage")),
            h(
              "div",
              { class: "weekday-checks" },
              [
                t("So"),
                t("Mo"),
                t("Di"),
                t("Mi"),
                t("Do"),
                t("Fr"),
                t("Sa"),
              ].map((d, i) =>
                h(
                  "label",
                  {},
                  h("input", {
                    type: "checkbox",
                    name: "days",
                    value: String(i),
                    checked: i === 0,
                  }),
                  d,
                ),
              ),
            ),
          ),
          field(
            t("Ausnahmen als Datum, mit Komma trennen"),
            "blackouts",
            "",
            "text",
            { placeholder: "2026-12-25, 2027-01-01" },
          ),
          h(
            "p",
            { class: "callout small" },
            t(
              "Sommerzeit: übersprungene Uhrzeiten werden auf die nächste gültige Minute verschoben; doppelte Uhrzeiten werden einmal ausgeführt. Vergangene Fenster werden nicht nachgeholt.",
            ),
          ),
          h(
            "button",
            { type: "submit", class: "btn primary" },
            t("Fenster speichern"),
          ),
        ),
      ];
    } else if (kind === "policy" || kind === "exclude") {
      title =
        kind === "exclude"
          ? t("Container ausschließen")
          : t("Richtlinie bearbeiten");
      const selected = policy || {
        id: c ? c.id : "global",
        scope: c ? "container" : "global",
        target: c?.id || "",
        mode: kind === "exclude" ? "disabled" : "scan-only",
        excluded: kind === "exclude",
        concurrency: 1,
        windowId: "",
      };
      body = [
        h(
          "form",
          { "data-form": "savePolicy", "data-id": selected.id },
          field(t("Kennung"), "id", selected.id, "text", {
            required: true,
            pattern: "[A-Za-z0-9_.-]{1,128}",
            readonly: !!policy || !!c,
          }),
          select(t("Geltungsbereich"), "scope", selected.scope, [
            ["global", t("Global")],
            ["host", t("Host")],
            ["group", t("Gruppe")],
            ["container", t("Container")],
          ]),
          field(t("Ziel-ID oder Gruppenname"), "target", selected.target),
          select(
            t("Update-Modus"),
            "mode",
            selected.mode,
            Object.entries(modeLabel),
          ),
          select(t("Wartungsfenster"), "windowId", selected.windowId, [
            ["", t("Keines")],
            ...(vm.windows || []).map((w) => [w.id, w.name]),
          ]),
          field(
            t("Maximale Parallelität"),
            "concurrency",
            String(selected.concurrency),
            "number",
            { min: 1, max: 4, required: true },
          ),
          h(
            "label",
            { class: "checkbox" },
            h("input", {
              type: "checkbox",
              name: "excluded",
              checked: selected.excluded,
            }),
            t("Explizit ausschließen"),
          ),
          h(
            "p",
            { class: "callout small" },
            t(
              "1 bis 4 Updates gleichzeitig. Grenzen der globalen, Host- und Gruppenrichtlinien gelten gemeinsam; ohne globale Einstellung bleibt die Grenze 1. Dienste desselben Compose-Projekts werden zum Schutz des gemeinsamen Sollzustands nacheinander aktualisiert. Übergeordnete Ausschlüsse bleiben wirksam.",
            ),
          ),
          h(
            "fieldset",
            { class: "execution-permissions" },
            h("legend", {}, t("Erweiterte Ausführungsfreigaben")),
            h(
              "p",
              { class: "callout small", role: "note" },
              t(
                "Achtung: Monitoring-Mounts geben dem Container Einblick in Host-Prozesse und Systeminformationen. Die Freigabe gilt dauerhaft für Updates dieses Containers, einschließlich automatischer Läufe. Nur für vertrauenswürdige Images aktivieren. Volumes und Anwendungsdaten werden bei einem Fehler nicht automatisch zurückgesetzt.",
              ),
            ),
            h(
              "label",
              { class: "checkbox" },
              h("input", {
                type: "checkbox",
                name: "readOnlyHostMonitoring",
                checked: selected.permissions?.readOnlyHostMonitoring,
                disabled: !can(vm, "execution.monitoring.grant"),
              }),
              t("Bestehende lesende Host-Mounts für Monitoring zulassen"),
            ),
            h(
              "p",
              { class: "muted small" },
              t(
                "Nur für eine Container-Richtlinie. Quelle, Ziel und Readonly-Status werden erhalten. Schreibende System-Mounts und Docker-Sockets benötigen einen eigenen, derzeit nicht unterstützten Freigabetyp. Die Änderung benötigt die Fähigkeit „Lesenden Host-Monitoring-Zugriff freigeben“.",
              ),
            ),
            field(
              t("Freigabegrund"),
              "permissionReason",
              selected.permissionReason || "",
              "text",
              {
                maxlength: 500,
                disabled: !can(vm, "execution.monitoring.grant"),
              },
            ),
            h(
              "label",
              { class: "checkbox" },
              h("input", {
                type: "checkbox",
                name: "permissionsConfirmed",
                disabled: !can(vm, "execution.monitoring.grant"),
              }),
              t(
                "Ich habe die Auswirkungen geprüft und bestätige den Host-Zugriff.",
              ),
            ),
          ),
          h(
            "button",
            { class: "btn primary", type: "submit" },
            t("Richtlinie speichern"),
          ),
        ),
      ];
    } else if (kind === "run") {
      title = t("Update-Lauf starten");
      const candidates = executableCandidates(vm);
      const canRunAll = can(vm, "updates.approve");
      body = [
        h(
          "form",
          { "data-form": "execute" },
          select(
            t("Container"),
            "containerId",
            c?.id || candidates[0]?.id || "",
            [
              ["", t("Container auswählen")],
              ...(canRunAll
                ? [
                    [
                      "__all__",
                      t("Alle auswählen – {v0} ausführbare Updates", {
                        v0: candidates.length,
                      }),
                    ],
                  ]
                : []),
              ...candidates.map((c) => [c.id, c.name]),
            ],
          ),
          h(
            "p",
            { class: "callout" },
            t(
              "Container werden neu erstellt und sind kurzzeitig nicht erreichbar. Datenbanken und Volumes werden nicht zurückgesetzt. Einzeljobs beachten Freigaben und Wartungsfenster. „Alle auswählen“ startet als bestätigter Administrator-Sofortlauf außerhalb der Wartungsfenster und gibt die ausgewählten Updates frei; Ausschlüsse und Parallelitätsgrenzen bleiben wirksam. Ein fehlgeschlagener Healthcheck erfordert einen manuellen Eingriff.",
            ),
          ),
          field(t("Grund / Ticket"), "reason", "", "text", {
            required: true,
            minlength: 3,
            maxlength: 500,
          }),
          h(
            "label",
            { class: "checkbox" },
            h("input", { name: "confirmed", type: "checkbox", required: true }),
            t("Ich bestätige den Neustart und die mögliche Unterbrechung."),
          ),
          h(
            "button",
            {
              type: "submit",
              class: "btn primary",
              disabled: !candidates.length,
            },
            t("Update-Lauf starten"),
          ),
        ),
        !candidates.length
          ? h(
              "p",
              { class: "muted" },
              t(
                "Keine freigegebenen Kandidaten. Erst Updates prüfen und die Richtlinie konfigurieren.",
              ),
            )
          : null,
      ];
    } else if (kind === "approve" || kind === "cancel") {
      title = kind === "approve" ? t("Update freigeben") : t("Job abbrechen");
      body = [
        h("p", {}, job?.name || ""),
        h(
          "form",
          {
            "data-form": kind === "approve" ? "approveJob" : "cancelJob",
            "data-id": job?.id || "",
          },
          field(t("Begründung"), "reason", "", "text", {
            required: true,
            minlength: 3,
            maxlength: 500,
          }),
          h(
            "label",
            { class: "checkbox" },
            h("input", { name: "confirmed", type: "checkbox", required: true }),
            kind === "approve"
              ? t("Ich bestätige die Ausführung und mögliche Unterbrechung.")
              : t("Ich bestätige den Abbruch."),
          ),
          h(
            "button",
            { type: "submit", class: "btn primary" },
            kind === "approve" ? t("Freigeben") : t("Abbrechen"),
          ),
        ),
      ];
    } else if (kind === "user") {
      title = t("Benutzer anlegen");
      body = [
        h(
          "form",
          { "data-form": "saveUser" },
          field(t("Name"), "name", "", "text", {
            required: true,
            minlength: 3,
            maxlength: 80,
          }),
          field(t("Initiales Passwort"), "password", "", "password", {
            required: true,
            minlength: 12,
            autocomplete: "new-password",
          }),
          select(t("Rolle"), "role", "Viewer", [
            ["Viewer", t("Viewer – nur lesen")],
            ["Operator", t("Operator – prüfen und Jobs anlegen")],
            ...(vm.user?.role === "Owner"
              ? [
                  [
                    "Administrator",
                    t("Administrator – freigeben und verwalten"),
                  ],
                ]
              : []),
          ]),
          h(
            "button",
            { type: "submit", class: "btn primary" },
            t("Benutzer speichern"),
          ),
        ),
      ];
    }
    return [
      h(
        "dialog",
        {
          "aria-labelledby": "dialog-title",
          class: kind === "help" ? "help-dialog" : "",
        },
        h(
          "div",
          { class: "dialog-heading" },
          h("h2", { id: "dialog-title" }, title),
          button("", "close", "", "", "icon-btn", "close"),
        ),
        h("div", { class: "dialog-content" }, body),
      ),
    ];
  }
  submit(form) {
    const f = new FormData(form),
      data = Object.fromEntries(f),
      kind = form.dataset.form;
    let id = form.dataset.id || "";
    if (kind === "saveWindow") {
      data.days = f.getAll("days").map(Number);
      data.durationMinutes = Number(data.durationMinutes);
      data.blackouts = String(data.blackouts)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      data.enabled = true;
    }
    if (kind === "savePolicy") {
      id = String(data.id);
      delete data.id;
      data.excluded = bool(data.excluded);
      data.concurrency = Number(data.concurrency);
      const previous = (this.vm.policies || []).find((p) => p.id === id);
      if (can(this.vm, "execution.monitoring.grant")) {
        const enabled = bool(data.readOnlyHostMonitoring);
        const confirmation = form.elements.namedItem("permissionsConfirmed");
        const reason = form.elements.namedItem("permissionReason");
        confirmation.setCustomValidity("");
        reason.setCustomValidity("");
        if (enabled && !bool(data.permissionsConfirmed)) {
          confirmation.setCustomValidity(
            t("Bestätige zuerst den Warnhinweis zum Host-Zugriff."),
          );
          confirmation.reportValidity();
          return;
        }
        if (enabled && String(data.permissionReason || "").trim().length < 3) {
          reason.setCustomValidity(
            t("Bitte gib einen Freigabegrund mit mindestens drei Zeichen an."),
          );
          reason.reportValidity();
          return;
        }
        data.permissions = { readOnlyHostMonitoring: enabled };
        data.permissionsConfirmed = enabled && bool(data.permissionsConfirmed);
        data.permissionReason = enabled
          ? String(data.permissionReason).trim()
          : "";
      } else {
        data.permissions = previous?.permissions || {};
        data.permissionReason = previous?.permissionReason || "";
        data.permissionsConfirmed = previous?.permissionsConfirmed || false;
      }
      delete data.readOnlyHostMonitoring;
    }
    if (["execute", "approveJob", "cancelJob"].includes(kind)) {
      data.confirmed = bool(data.confirmed);
      if (data.containerId) {
        id = String(data.containerId);
        delete data.containerId;
      }
    }
    this.emit(kind, "", id, data);
  }
}
register("x-approval-dialog", XApprovalDialog);
export class XCUOWorkspace extends Widget {
  connectedCallback() {
    super.connectedCallback();
    bindAppearance(this);
    bindSettingsTabs(this);
  }
  submit(form) {
    if (form.dataset.form !== "saveOIDC") return;
    const data = Object.fromEntries(new FormData(form));
    for (const key of [
      "enabled",
      "clearSecret",
      "autoProvision",
      "localLoginEnabled",
    ])
      data[key] = form.elements[key].checked;
    this.emit("saveOIDC", "", "", data);
    form.elements.clientSecret.value = "";
  }
  render() {
    const vm = this.vm;
    switch (this.getAttribute("section")) {
      case "users":
        return [
          h(
            "div",
            { class: "panel-heading" },
            h("h2", {}, t("Benutzer & Rollen")),
            button(
              t("Benutzer anlegen"),
              "user",
              "",
              "",
              "btn primary",
              "plus",
            ),
          ),
          h(
            "div",
            { class: "policy-list" },
            (vm.users || []).map((user) =>
              h(
                "article",
                { class: "policy-card" },
                h(
                  "div",
                  { class: "policy-heading" },
                  h("h3", { class: "policy-title" }, user.name),
                  h("span", { class: "badge blue" }, user.role),
                ),
                h("p", { class: "muted" }, "Hosts: " + user.hosts.join(", ")),
                user.id !== vm.user?.id
                  ? button(
                      t("Sitzungen widerrufen"),
                      "revokeUser",
                      "",
                      user.id,
                      "btn",
                    )
                  : null,
              ),
            ),
          ),
          h(
            "p",
            { class: "callout" },
            t(
              "Rollen und Host-Berechtigungen werden serverseitig geprüft. Sitzungen sind nach zwölf Stunden ungültig.",
            ),
          ),
        ];
      case "integrations":
        return [
          h("h2", {}, t("Integrationen")),
          h(
            "div",
            { class: "integrations-grid" },
            h(
              "article",
              { class: "policy-card" },
              h(
                "div",
                { class: "policy-heading" },
                h("h3", { class: "policy-title" }, t("Docker Engine")),
                h("span", { class: "badge good" }, t("Verbunden")),
              ),
              h(
                "p",
                {},
                t("Interner Host-Agent mit expliziter Container-Freigabe."),
              ),
            ),
            oidcSettings(vm),
          ),
        ];
      default:
        return workspaceSettings(vm);
    }
  }
  update() {
    super.update();
    for (const widget of this.content.querySelectorAll(
      "x-container-table,x-maintenance-planner,x-policy-editor,x-update-run-timeline,x-host-health,x-log-stream,x-cuo-log-retention",
    ))
      widget.vm = this.vm;
  }
}
register("x-cuo-workspace", XCUOWorkspace);
