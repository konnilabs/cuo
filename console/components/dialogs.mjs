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
          h("span", { class: "muted" }, "v0.1.0"),
        ),
        h("p", { class: "eyebrow" }, "CONTAINER UPDATE ORCHESTRATOR"),
        h(
          "h1",
          {},
          vm.auth === "loading"
            ? "CUO wird gestartet …"
            : enroll
              ? "Deinen Workspace einrichten"
              : "Willkommen zurück",
        ),
        h(
          "p",
          { class: "muted" },
          enroll
            ? "Lege den ersten lokalen Administrator an. Deine Daten bleiben auf diesem Host."
            : "Melde dich an, um deine Container zu verwalten.",
        ),
        vm.auth === "loading"
          ? null
          : h(
              "form",
              { "data-form": enroll ? "enroll" : "login" },
              field("Benutzername", "name", "", "text", {
                required: true,
                autocomplete: "username",
                minlength: 3,
                maxlength: 80,
              }),
              field("Passwort", "password", "", "password", {
                required: true,
                autocomplete: enroll ? "new-password" : "current-password",
                minlength: 12,
                maxlength: 256,
              }),
              enroll
                ? h(
                    "p",
                    { class: "muted small" },
                    "Mindestens 12 Zeichen. Das Konto erhält die Rolle Owner.",
                  )
                : null,
              h(
                "button",
                { class: "btn primary full", type: "submit" },
                enroll ? "Administrator anlegen" : "Anmelden",
              ),
            ),
        vm.notice
          ? h("p", { class: "form-error", role: "alert" }, vm.notice)
          : null,
        h(
          "div",
          { class: "auth-footer" },
          icon("shield"),
          h("span", {}, "Lokal installiert · sichere Sitzung"),
        ),
        button("Design-Demo ansehen", "demo", "", "", "text-btn"),
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
    let title = "",
      body = [];
    if (kind === "container") {
      title = c?.name || "Update-Lauf";
      body = c
        ? [
            h(
              "div",
              { class: "detail-grid" },
              [
                ["Image", c.image],
                ["Plattform", c.platform],
                ["Status", c.state],
                ["Gruppe", c.group],
                ["Richtlinie", modeLabel[c.mode]],
                [
                  "Verwaltet",
                  c.managed ? "Ja" : "Nein – cuo.managed=true benötigt",
                ],
                [
                  "Compose",
                  c.compose ? "Ja – registriertes Projekt benötigt" : "Nein",
                ],
                [
                  "Update-Digest",
                  c.candidate?.targetDigest || "Kein Update bekannt",
                ],
                ["Hinweis", c.candidate?.error || c.reason || "–"],
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
              button("Richtlinie bearbeiten", "policy", "", c.id, "btn"),
              button("Update planen", "run", "", c.id, "btn primary", "play"),
            ),
          ]
        : [
            h(
              "p",
              {},
              job
                ? stageLabel[job.state] || job.state
                : "Eintrag ist nicht mehr im aktuellen Inventar vorhanden.",
            ),
          ];
    } else if (kind === "add") {
      title = "Container hinzufügen";
      body = [
        h(
          "p",
          {},
          "CUO entdeckt Container auf dem lokalen Docker-Host automatisch. Die App erstellt keine beliebigen neuen Workloads.",
        ),
        h(
          "ol",
          { class: "instructions" },
          h("li", {}, "Container mit Docker oder Compose anlegen."),
          h("li", {}, "Für Updates das Label cuo.managed=true setzen."),
          h(
            "li",
            {},
            "Inventar aktualisieren und eine Update-Richtlinie wählen.",
          ),
        ),
        h("code", { class: "code-block" }, 'labels:\n  cuo.managed: "true"'),
        h(
          "p",
          { class: "muted" },
          "Compose: zusätzlich cuo.compose.file relativ zum registrierten Projektverzeichnis setzen.",
        ),
        button(
          "Inventar aktualisieren",
          "discover",
          "",
          "",
          "btn primary",
          "refresh",
        ),
      ];
    } else if (kind === "windowDetails") {
      const window = (vm.windows || []).find((w) => w.id === vm.selected);
      title = "Wartungsfenster";
      body = window
        ? [
            h("h3", {}, window.name),
            h(
              "div",
              { class: "detail-grid" },
              [
                ["Start", window.start + " Uhr"],
                ["Dauer", window.durationMinutes + " Minuten"],
                ["Zeitzone", window.timezone],
                ["Status", window.enabled ? "Aktiv" : "Deaktiviert"],
                [
                  "Wochentage",
                  window.days
                    .map(
                      (day) => ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][day],
                    )
                    .join(", "),
                ],
                ["Ausnahmen", window.blackouts?.join(", ") || "Keine"],
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
              "Laufende Jobs werden beim Fensterende nicht unterbrochen. Vergangene Fenster werden nicht nachgeholt.",
            ),
          ]
        : [h("p", {}, "Wartungsfenster nicht mehr vorhanden.")];
    } else if (kind === "window") {
      title = "Wartungsfenster erstellen";
      body = [
        h(
          "form",
          { "data-form": "saveWindow" },
          field("Name", "name", "Standard", "text", {
            required: true,
            maxlength: 100,
          }),
          h(
            "div",
            { class: "form-grid" },
            field("Startzeit", "start", "03:00", "time", { required: true }),
            field("Dauer in Minuten", "durationMinutes", "60", "number", {
              min: 1,
              max: 1440,
              required: true,
            }),
          ),
          field("IANA-Zeitzone", "timezone", "Europe/Berlin", "text", {
            required: true,
          }),
          h(
            "fieldset",
            {},
            h("legend", {}, "Wochentage"),
            h(
              "div",
              { class: "weekday-checks" },
              ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"].map((d, i) =>
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
            "Ausnahmen als Datum, mit Komma trennen",
            "blackouts",
            "",
            "text",
            { placeholder: "2026-12-25, 2027-01-01" },
          ),
          h(
            "p",
            { class: "callout small" },
            "Sommerzeit: übersprungene Uhrzeiten werden auf die nächste gültige Minute verschoben; doppelte Uhrzeiten werden einmal ausgeführt. Vergangene Fenster werden nicht nachgeholt.",
          ),
          h(
            "button",
            { type: "submit", class: "btn primary" },
            "Fenster speichern",
          ),
        ),
      ];
    } else if (kind === "policy" || kind === "exclude") {
      title =
        kind === "exclude" ? "Container ausschließen" : "Richtlinie bearbeiten";
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
          field("Kennung", "id", selected.id, "text", {
            required: true,
            pattern: "[A-Za-z0-9_.-]{1,128}",
            readonly: !!policy || !!c,
          }),
          select("Geltungsbereich", "scope", selected.scope, [
            ["global", "Global"],
            ["host", "Host"],
            ["group", "Gruppe"],
            ["container", "Container"],
          ]),
          field("Ziel-ID oder Gruppenname", "target", selected.target),
          select(
            "Update-Modus",
            "mode",
            selected.mode,
            Object.entries(modeLabel),
          ),
          select("Wartungsfenster", "windowId", selected.windowId, [
            ["", "Keines"],
            ...(vm.windows || []).map((w) => [w.id, w.name]),
          ]),
          field(
            "Maximale Parallelität",
            "concurrency",
            String(selected.concurrency),
            "number",
            { min: 1, max: 1, required: true },
          ),
          h(
            "label",
            { class: "checkbox" },
            h("input", {
              type: "checkbox",
              name: "excluded",
              checked: selected.excluded,
            }),
            "Explizit ausschließen",
          ),
          h(
            "p",
            { class: "callout small" },
            "Die lokale Ausführung erfolgt seriell. Ein Ausschluss auf einer übergeordneten Ebene bleibt wirksam.",
          ),
          h(
            "button",
            { class: "btn primary", type: "submit" },
            "Richtlinie speichern",
          ),
        ),
      ];
    } else if (kind === "run") {
      title = "Update-Lauf starten";
      const candidates = (vm.containers || []).filter(
        (c) =>
          c.candidate?.targetDigest && !c.excluded && c.mode !== "scan-only",
      );
      body = [
        h(
          "form",
          { "data-form": "execute" },
          select("Container", "containerId", c?.id || candidates[0]?.id || "", [
            ["", "Container auswählen"],
            ...candidates.map((c) => [c.id, c.name]),
          ]),
          h(
            "p",
            { class: "callout" },
            "Der ausgewählte Container wird neu erstellt und ist kurzzeitig nicht erreichbar. Datenbanken und Volumes werden nicht zurückgesetzt. Ein fehlgeschlagener Healthcheck erfordert einen manuellen Eingriff.",
          ),
          field("Grund / Ticket", "reason", "", "text", {
            required: true,
            minlength: 3,
            maxlength: 500,
          }),
          h(
            "label",
            { class: "checkbox" },
            h("input", { name: "confirmed", type: "checkbox", required: true }),
            "Ich bestätige den Neustart und die mögliche Unterbrechung.",
          ),
          h(
            "button",
            {
              type: "submit",
              class: "btn primary",
              disabled: !candidates.length,
            },
            "Update-Job anlegen",
          ),
        ),
        !candidates.length
          ? h(
              "p",
              { class: "muted" },
              "Keine freigegebenen Kandidaten. Erst Updates prüfen und die Richtlinie konfigurieren.",
            )
          : null,
      ];
    } else if (kind === "approve" || kind === "cancel") {
      title = kind === "approve" ? "Update freigeben" : "Job abbrechen";
      body = [
        h("p", {}, job?.name || ""),
        h(
          "form",
          {
            "data-form": kind === "approve" ? "approveJob" : "cancelJob",
            "data-id": job?.id || "",
          },
          field("Begründung", "reason", "", "text", {
            required: true,
            minlength: 3,
            maxlength: 500,
          }),
          h(
            "label",
            { class: "checkbox" },
            h("input", { name: "confirmed", type: "checkbox", required: true }),
            kind === "approve"
              ? "Ich bestätige die Ausführung und mögliche Unterbrechung."
              : "Ich bestätige den Abbruch.",
          ),
          h(
            "button",
            { type: "submit", class: "btn primary" },
            kind === "approve" ? "Freigeben" : "Abbrechen",
          ),
        ),
      ];
    } else if (kind === "user") {
      title = "Benutzer anlegen";
      body = [
        h(
          "form",
          { "data-form": "saveUser" },
          field("Name", "name", "", "text", {
            required: true,
            minlength: 3,
            maxlength: 80,
          }),
          field("Initiales Passwort", "password", "", "password", {
            required: true,
            minlength: 12,
            autocomplete: "new-password",
          }),
          select("Rolle", "role", "Viewer", [
            ["Viewer", "Viewer – nur lesen"],
            ["Operator", "Operator – prüfen und Jobs anlegen"],
            ...(vm.user?.role === "Owner"
              ? [["Administrator", "Administrator – freigeben und verwalten"]]
              : []),
          ]),
          h(
            "button",
            { type: "submit", class: "btn primary" },
            "Benutzer speichern",
          ),
        ),
      ];
    }
    return [
      h(
        "dialog",
        { "aria-labelledby": "dialog-title" },
        h(
          "div",
          { class: "dialog-heading" },
          h("h2", { id: "dialog-title" }, title),
          button("", "close", "", "", "icon-btn", "close"),
        ),
        h(
          "div",
          { class: "dialog-content" },
          body,
          vm.notice && vm.error
            ? h("p", { role: "alert", class: "form-error" }, vm.notice)
            : null,
        ),
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
  render() {
    const vm = this.vm;
    switch (this.getAttribute("section")) {
      case "users":
        return [
          h(
            "div",
            { class: "panel-heading" },
            h("h2", {}, "Benutzer & Rollen"),
            button("Benutzer anlegen", "user", "", "", "btn primary", "plus"),
          ),
          h(
            "div",
            { class: "policy-list" },
            (vm.users || []).map((user) =>
              h(
                "article",
                { class: "policy-card" },
                h("h3", {}, user.name),
                h("span", { class: "badge blue" }, user.role),
                h("p", { class: "muted" }, "Hosts: " + user.hosts.join(", ")),
                user.id !== vm.user?.id
                  ? button(
                      "Sitzungen widerrufen",
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
            "Rollen und Host-Berechtigungen werden serverseitig geprüft. Sitzungen sind nach zwölf Stunden ungültig.",
          ),
        ];
      case "integrations":
        return [
          h("h2", {}, "Integrationen"),
          h(
            "div",
            { class: "policy-list" },
            h(
              "article",
              { class: "policy-card" },
              h("h3", {}, "Docker Engine"),
              h("span", { class: "badge good" }, "Verbunden"),
              h(
                "p",
                {},
                "Interner Host-Agent mit expliziter Container-Freigabe.",
              ),
            ),
            h(
              "article",
              { class: "policy-card" },
              h("h3", {}, "Nextcloud / OIDC"),
              h("span", { class: "badge muted" }, "Optional · nicht aktiviert"),
              h(
                "p",
                { class: "muted" },
                "Das lokale MVP nutzt eigene Benutzerkonten. OIDC ist eine Erweiterung der Architektur.",
              ),
            ),
          ),
        ];
      default:
        return [
          h("h2", {}, "Workspace-Einstellungen"),
          h(
            "div",
            { class: "settings-list" },
            h(
              "article",
              {},
              h("h3", {}, "Darstellung"),
              h(
                "p",
                { class: "muted" },
                "Helles oder dunkles Farbschema für diese Sitzung.",
              ),
              button("Farbschema wechseln", "theme", "", "", "btn", "sun"),
            ),
            h(
              "article",
              {},
              h("h3", {}, "Lokale Installation"),
              h("p", {}, "CUO 0.1.0 · Go Core · XTend Maraca / RMT"),
              h(
                "p",
                { class: "muted" },
                "SQLite-Speicher und Agent-Journale liegen in persistenten Docker-Volumes.",
              ),
            ),
            h(
              "article",
              {},
              h("h3", {}, "Sitzung"),
              h("p", {}, vm.user?.name + " · " + vm.user?.role),
              button("Abmelden", "logout", "", "", "btn"),
            ),
          ),
        ];
    }
  }
  update() {
    super.update();
    for (const widget of this.content.querySelectorAll(
      "x-container-table,x-maintenance-planner,x-policy-editor,x-update-run-timeline,x-host-health,x-log-stream",
    ))
      widget.vm = this.vm;
  }
}
register("x-cuo-workspace", XCUOWorkspace);
