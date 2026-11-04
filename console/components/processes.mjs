import { t } from "../i18n/index.mjs";
import {
  Widget,
  closeButton,
  syncModal,
  register,
  h,
  button,
  field,
  select,
  formatDate,
  stageLabel,
} from "./base.mjs";
const states = {
  running: "In Ausführung",
  partial: "Teilweise fehlgeschlagen",
  planned: "Vorgemerkt",
  blocked: "Voraussetzung fehlt",
  event_driven: "Nach nächster Prüfung",
};
const duration = (ms) =>
  ms > 0
    ? ms < 1000
      ? `${ms} ms`
      : ms < 60000
        ? `${(ms / 1000).toFixed(1)} s`
        : `${(ms / 60000).toFixed(1)} min`
    : "–";
const tone = (state) =>
  ["failed", "partial", "intervention_required"].includes(state)
    ? "warning"
    : state === "succeeded"
      ? "good"
      : "muted";
const badge = (state) =>
  h(
    "span",
    { class: "badge " + tone(state) },
    t(states[state] || stageLabel[state] || state),
  );
const metric = (label, value) =>
  h(
    "div",
    { class: "process-metric" },
    h("small", { class: "muted" }, label),
    h("strong", {}, value),
  );
const permission = (vm) =>
  vm.user?.role === "Owner" || (vm.capabilities || []).includes("logs.manage");
export class XCUOProcessManager extends Widget {
  render() {
    const vm = this.vm,
      rows = vm.processRuns || [];
    return [
      h(
        "div",
        { class: "panel-heading" },
        h(
          "div",
          {},
          h("h2", {}, t("Prozessmanager")),
          h(
            "p",
            { class: "muted" },
            t(
              "Eindeutige Lauf-IDs, Ausführungsphasen und nächste geplante Prüfungen.",
            ),
          ),
        ),
        button(t("Aktualisieren"), "processRefresh", "", "", "btn", "refresh"),
      ),
      h(
        "div",
        { class: "process-summary" },
        metric(t("Gefundene Läufe"), String(vm.processTotal || 0)),
        metric(
          t("Geplante Ausführungen"),
          String((vm.processUpcoming || []).length),
        ),
        metric(
          t("Anzeige"),
          vm.processKind === "forecast"
            ? t("Planungsvorschau")
            : t("Dauerhafte Laufhistorie"),
        ),
      ),
      h(
        "div",
        { class: "tabs", role: "group", "aria-label": t("Prozesse filtern") },
        [
          ["run", t("Vergangene & aktive Läufe")],
          ["forecast", t("Nächste Ausführungen")],
        ].map(([value, label]) =>
          h(
            "button",
            {
              type: "button",
              class: "tab " + (vm.processKind === value ? "selected" : ""),
              "data-kind": "processKind",
              "data-value": value,
              "aria-pressed": String(vm.processKind === value),
            },
            label,
          ),
        ),
      ),
      h(
        "form",
        { "data-form": "processFilter", class: "process-filters" },
        field(
          t("Suche nach Name oder Lauf-ID"),
          "query",
          vm.processQuery || "",
          "search",
        ),
        select(t("Status"), "status", vm.processStatus || "all", [
          ["all", t("Alle")],
          ["active", t("Aktiv")],
          ["completed", t("Abgeschlossen")],
          ["attention", t("Auffällig")],
          ["scheduled", t("Geplant")],
          ["succeeded", t("Erfolgreich")],
          ["failed", t("Fehlgeschlagen")],
          ["blocked", t("Voraussetzung fehlt")],
        ]),
        field(t("Von (UTC)"), "from", vm.processFrom || "", "date"),
        field(t("Bis (UTC)"), "to", vm.processTo || "", "date"),
        h("button", { type: "submit", class: "btn" }, t("Filter anwenden")),
      ),
      vm.processKind === "forecast"
        ? h(
            "p",
            { class: "notice" },
            t(
              "Vorschau, kein Ausführungsversprechen: Ein neuer Image-Digest, ein laufender Container und passende Freigaben sind erforderlich. Bereits angelegte geplante Jobs stehen in der Laufhistorie.",
            ),
          )
        : null,
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          { class: "process-table" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              [
                t("Lauf / ID"),
                t("Status"),
                "Start / Planung",
                t("Dauer"),
                t("Container"),
                t("Hinweise"),
                t("Details"),
              ].map((t) => h("th", { scope: "col" }, t)),
            ),
          ),
          h(
            "tbody",
            {},
            rows.length
              ? rows.map((r) =>
                  h(
                    "tr",
                    { key: r.id },
                    h(
                      "td",
                      {},
                      h("strong", {}, r.name),
                      h("code", { class: "process-id", title: r.id }, r.id),
                    ),
                    h("td", {}, badge(r.state)),
                    h(
                      "td",
                      {},
                      r.kind === "forecast" && !r.nextStart
                        ? t("Ereignisgesteuert")
                        : formatDate(r.nextStart || r.startedAt || r.createdAt),
                    ),
                    h("td", {}, duration(r.durationMs)),
                    h(
                      "td",
                      {},
                      t("{v0} erfolgreich · {v1} Fehler · {v2} gesamt", {
                        v0: r.succeeded || 0,
                        v1: r.failed || 0,
                        v2: r.containerCount,
                      }),
                    ),
                    h(
                      "td",
                      {},
                      r.kind === "forecast"
                        ? r.reason
                        : (r.anomalies || [])
                            .filter((a) => a.severity !== "info")
                            .map((a) => a.message)
                            .join(" · ") || t("Keine Auffälligkeit erkannt"),
                    ),
                    h(
                      "td",
                      {},
                      button(
                        t("Details"),
                        "processDetails",
                        "",
                        r.id,
                        "btn small",
                      ),
                    ),
                  ),
                )
              : h(
                  "tr",
                  {},
                  h(
                    "td",
                    { colspan: 7, class: "empty" },
                    t("Keine passenden Läufe vorhanden."),
                  ),
                ),
          ),
        ),
      ),
      h(
        "div",
        { class: "pagination" },
        h(
          "span",
          {},
          t("{v0}–{v1} von {v2}", {
            v0: rows.length ? (vm.processOffset || 0) + 1 : 0,
            v1: (vm.processOffset || 0) + rows.length,
            v2: vm.processTotal || 0,
          }),
        ),
        h(
          "div",
          { class: "inline" },
          h(
            "button",
            {
              type: "button",
              class: "page-btn",
              "data-kind": "processPage",
              "data-value": String(Math.max(0, (vm.processOffset || 0) - 50)),
              disabled: !vm.processOffset,
              "aria-label": t("Vorherige Prozesse"),
            },
            "‹",
          ),
          h(
            "button",
            {
              type: "button",
              class: "page-btn",
              "data-kind": "processPage",
              "data-value": String((vm.processOffset || 0) + 50),
              disabled:
                (vm.processOffset || 0) + rows.length >= (vm.processTotal || 0),
              "aria-label": t("Weitere Prozesse"),
            },
            "›",
          ),
        ),
      ),
    ];
  }
  submit(form) {
    this.emit("processFilter", "", "", Object.fromEntries(new FormData(form)));
  }
}
register("x-cuo-process-manager", XCUOProcessManager);
export class XCUOProcessDetail extends Widget {
  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.addEventListener(
      "cancel",
      (e) => {
        e.preventDefault();
        this.emit("close");
      },
      { capture: true, signal: this.controller.signal },
    );
  }
  update() {
    super.update();
    syncModal(this, this.vm.dialog === "process");
  }
  render() {
    const vm = this.vm;
    if (vm.dialog !== "process") return [];
    const detail = vm.processDetail;
    if (!detail)
      return [
        h(
          "dialog",
          { "aria-label": t("Laufdetails"), class: "process-dialog" },
          h(
            "div",
            { class: "dialog-heading" },
            h("h2", {}, t("Laufdetails werden geladen")),
            closeButton(),
          ),
        ),
      ];
    const r = detail.run;
    const jobs = (detail.jobs || []).map((j) =>
      h(
        "article",
        { class: "job-card", key: j.id },
        h(
          "div",
          { class: "panel-heading" },
          h("strong", {}, j.name),
          badge(j.state),
        ),
        h("code", { class: "process-id" }, j.id),
        h("p", { class: "muted" }, j.reason),
        h(
          "div",
          { class: "process-snapshots" },
          h("div", {}, h("h4", {}, t("Vorher")), snapshot(j.before)),
          h("div", {}, h("h4", {}, t("Nachher")), snapshot(j.after)),
        ),
        h(
          "ol",
          { class: "process-stages" },
          (j.stages || []).map((s, i) =>
            h(
              "li",
              { key: j.id + ":" + i },
              h("strong", {}, stageLabel[s.stage] || s.stage),
              h(
                "span",
                {},
                `${formatDate(s.startedAt)} → ${s.finishedAt ? formatDate(s.finishedAt) : t("läuft")}`,
              ),
              h("span", {}, duration(s.durationMs)),
            ),
          ),
        ),
      ),
    );
    const scanStages = h(
      "ol",
      { class: "process-stages" },
      (r.stages || []).map((s) =>
        h(
          "li",
          {},
          h(
            "strong",
            {},
            s.stage === "inventory"
              ? t("Bestandsabgleich")
              : t("Registry-Prüfung"),
          ),
          h("span", {}, duration(s.durationMs)),
        ),
      ),
    );
    const logs = h(
      "section",
      {},
      h("h3", {}, t("Zugehörige Logs")),
      detail.logsPruned
        ? h(
            "p",
            { class: "notice" },
            t(
              "Ältere Protokolle dieses Laufs wurden gelöscht. Lauf-ID, Status, Snapshots und gespeicherte Phasenzeiten bleiben erhalten.",
            ),
          )
        : null,
      h(
        "div",
        { class: "process-log", tabindex: 0, "aria-label": t("Laufprotokoll") },
        (detail.events || []).map((ev) =>
          h(
            "div",
            { key: ev.id, class: "process-log-line" },
            h("time", {}, formatDate(ev.time)),
            h("strong", {}, ev.severity),
            h("span", {}, ev.stage),
            h("span", {}, ev.message),
          ),
        ),
      ),
      !(detail.events || []).length
        ? h(
            "p",
            { class: "muted" },
            t("Keine zugehörigen Protokolle verfügbar."),
          )
        : null,
      detail.moreEvents
        ? button(t("Weitere Protokolle laden"), "processMore", "", "", "btn")
        : null,
    );
    return [
      h(
        "dialog",
        { class: "process-dialog", "aria-labelledby": "process-title" },
        h(
          "div",
          { class: "dialog-heading" },
          h(
            "div",
            {},
            h("h2", { id: "process-title" }, r.name),
            h("code", { class: "process-id" }, r.id),
          ),
          closeButton(),
        ),
        h(
          "div",
          { class: "dialog-content" },
          h(
            "div",
            { class: "inline" },
            badge(r.state),
            h(
              "span",
              { class: "muted" },
              r.kind === "forecast"
                ? t("Planungsvorschau")
                : t("Persistenter Lauf"),
            ),
            r.kind !== "forecast"
              ? button(
                  t("CSV-Logs"),
                  "downloadData",
                  "csv",
                  "logs",
                  "btn small",
                )
              : null,
            r.kind !== "forecast"
              ? button(
                  t("Excel-Details"),
                  "downloadData",
                  "xlsx",
                  "detail",
                  "btn small",
                )
              : null,
          ),
          h(
            "div",
            { class: "process-summary" },
            metric(t("Ausführungsdauer"), duration(r.durationMs)),
            metric("Wartezeit (Summe)", duration(r.queueMs)),
            metric(
              "Baseline (Median)",
              r.baselineSamples >= 3
                ? t("{v0} · {v1} Läufe", {
                    v0: duration(r.baselineMs),
                    v1: r.baselineSamples,
                  })
                : t("{v0}/3 Vergleichsläufe", { v0: r.baselineSamples || 0 }),
            ),
            metric(t("Protokollereignisse"), String(detail.eventCount || 0)),
          ),
          h(
            "dl",
            { class: "process-facts" },
            ["createdAt", "startedAt", "finishedAt", "nextStart"]
              .filter((k) => r[k])
              .map((k) => [
                h(
                  "dt",
                  {},
                  {
                    createdAt: t("Angelegt"),
                    startedAt: t("Gestartet"),
                    finishedAt: t("Beendet"),
                    nextStart: t("Nächster Start"),
                  }[k],
                ),
                h("dd", {}, formatDate(r[k])),
              ]),
            h("dt", {}, t("Anforderer")),
            h("dd", {}, r.requester || t("Automatische Planung")),
            h("dt", {}, t("Hinweis")),
            h("dd", {}, r.reason || "–"),
          ),
          r.kind === "forecast" ? h("p", { class: "notice" }, r.reason) : null,
          h(
            "section",
            {},
            h("h3", {}, t("Anomalien & Datenqualität")),
            (r.anomalies || []).length
              ? r.anomalies.map((a) =>
                  h(
                    "p",
                    {
                      class:
                        "notice " + (a.severity === "error" ? "error" : ""),
                      key: a.code,
                    },
                    a.message,
                  ),
                )
              : h(
                  "p",
                  { class: "muted" },
                  t(
                    "Keine regelbasierten Auffälligkeiten erkannt. Zeitvergleiche benötigen mindestens drei frühere erfolgreiche Läufe derselben Container.",
                  ),
                ),
          ),
          h(
            "section",
            {},
            h("h3", {}, t("Container & Phasen")),
            scanStages,
            jobs,
          ),
          (r.skipped || []).length
            ? h(
                "section",
                {},
                h("h3", {}, t("Übersprungene Container")),
                r.skipped.map((s) => h("p", {}, s.name + ": " + s.reason)),
              )
            : null,
          logs,
        ),
      ),
    ];
  }
}
function snapshot(s) {
  return s
    ? h(
        "dl",
        { class: "snapshot-data" },
        h("dt", {}, t("Docker-ID")),
        h("dd", {}, s.engineId),
        h("dt", {}, t("Laufzustand")),
        h("dd", {}, s.state),
        h("dt", {}, t("Image")),
        h("dd", {}, s.image),
        h("dt", {}, t("Konfiguration")),
        h("dd", {}, s.imageId),
      )
    : h(
        "p",
        { class: "muted" },
        t("Für diesen Zeitpunkt wurde kein Snapshot erfasst."),
      );
}
register("x-cuo-process-detail", XCUOProcessDetail);
export class XCUODataExport extends Widget {
  render() {
    const vm = this.vm,
      selected =
        this.getAttribute("dataset") ||
        (vm.processKind === "forecast" ? "upcoming" : "processes");
    return [
      h(
        "section",
        { class: "export-panel" },
        h("h3", {}, t("Datenstand herunterladen")),
        h(
          "form",
          { "data-form": "exportData", class: "process-filters" },
          select(t("Datenbestand"), "dataset", selected, [
            ["containers", t("Containerbestand")],
            ["processes", t("Laufhistorie")],
            ["upcoming", t("Planungsvorschau")],
            ["jobs", t("Einzelne Jobs")],
            ["logs", t("Protokolle")],
          ]),
          select(t("Dateiformat"), "format", "xlsx", [
            ["xlsx", t("Excel (.xlsx)")],
            ["csv", t("CSV (UTF-8)")],
          ]),
          field(t("Von (UTC)"), "from", vm.processFrom || "", "date"),
          field(t("Bis (UTC)"), "to", vm.processTo || "", "date"),
          field(t("Suchtext"), "query", vm.processQuery || "", "search"),
          select(
            t("Status (Läufe / Jobs)"),
            "status",
            vm.processStatus || "all",
            [
              ["all", t("Alle")],
              ["active", t("Aktiv")],
              ["completed", t("Abgeschlossen")],
              ["attention", t("Auffällig")],
              ["succeeded", t("Erfolgreich")],
              ["failed", t("Fehlgeschlagen")],
            ],
          ),
          h("button", { type: "submit", class: "btn" }, t("Herunterladen")),
        ),
        h(
          "p",
          { class: "muted small" },
          t(
            "Maximal 10.000 Zeilen / 16 MiB pro Download. Bei größeren Datenständen Zeitraum eingrenzen. Excel enthält zusätzlich Exportzeit und Filter.",
          ),
        ),
      ),
    ];
  }
  submit(form) {
    this.emit("exportData", "", "", Object.fromEntries(new FormData(form)));
  }
}
register("x-cuo-data-export", XCUODataExport);
export class XCUOLogRetention extends Widget {
  render() {
    const vm = this.vm,
      s = vm.logStorage;
    if (!s?.policy) return [];
    const p = s.policy;
    return [
      h(
        "section",
        { class: "retention-panel" },
        h(
          "div",
          { class: "panel-heading" },
          h("h3", {}, t("Log-Aufbewahrung")),
          h(
            "span",
            { class: "badge muted" },
            p.enabled ? t("Automatisch aktiv") : t("Automatik aus"),
          ),
        ),
        h(
          "p",
          { class: "muted" },
          t(
            "{v0} Ereignisse · {v1} MiB Datenbank · {v2} MiB wiederverwendbar · {v3} offene Jobs",
            {
              v0: s.events,
              v1: (s.databaseBytes / 1048576).toFixed(1),
              v2: (s.reusableBytes / 1048576).toFixed(1),
              v3: s.activeJobs,
            },
          ),
        ),
        p.lastRun
          ? h(
              "p",
              { class: "muted" },
              t("Letzte Bereinigung: {v0} · {v1} Einträge gelöscht", {
                v0: formatDate(p.lastRun),
                v1: p.lastDeleted,
              }),
            )
          : null,
        permission(vm)
          ? [
              h(
                "form",
                { "data-form": "saveLogRetention" },
                h("input", {
                  type: "hidden",
                  name: "revision",
                  value: p.revision,
                }),
                h(
                  "label",
                  { class: "check" },
                  h("input", {
                    type: "checkbox",
                    name: "enabled",
                    checked: p.enabled,
                  }),
                  t("Automatische Log-Rotation aktivieren"),
                ),
                h(
                  "div",
                  { class: "process-filters" },
                  field(
                    t("Maximales Alter (Tage)"),
                    "days",
                    String(p.days),
                    "number",
                    { min: 1, max: 3650, required: true },
                  ),
                  field(
                    t("Maximale Ereigniszahl"),
                    "maxEvents",
                    String(p.maxEvents),
                    "number",
                    { min: 100, max: 1000000, required: true },
                  ),
                  field(
                    t("Zyklus (Stunden)"),
                    "intervalHours",
                    String(p.intervalHours),
                    "number",
                    { min: 1, max: 720, required: true },
                  ),
                ),
                field(t("Begründung"), "reason", "", "text", {
                  minlength: 3,
                  maxlength: 500,
                  required: true,
                }),
                h(
                  "label",
                  { class: "check" },
                  h("input", {
                    type: "checkbox",
                    name: "confirmed",
                    required: true,
                  }),
                  t(
                    "Ich bestätige, dass abgelaufene Logs nach dieser Regel gelöscht werden dürfen.",
                  ),
                ),
                h(
                  "button",
                  { type: "submit", class: "btn" },
                  t("Aufbewahrung speichern"),
                ),
              ),
              h(
                "details",
                {},
                h("summary", {}, t("Bereinigung, Reset und Speicherfreigabe")),
                h(
                  "p",
                  { class: "notice" },
                  t(
                    "Diese Aktionen entfernen Protokolldaten unwiderruflich. Logs offener Jobs, Lauf-IDs, Status, Snapshots und Agent-Journale bleiben erhalten. Zuvor bei Bedarf exportieren. Komprimierung ist nur ohne offene Jobs möglich.",
                  ),
                ),
                h(
                  "form",
                  { "data-form": "logMaintenance" },
                  select(t("Aktion"), "action", "rotate", [
                    ["rotate", t("Jetzt nach Regel rotieren")],
                    ["reset", t("Logs abgeschlossener Prozesse zurücksetzen")],
                    ["compact", t("Freien Datenbankspeicher komprimieren")],
                  ]),
                  field(t("Begründung"), "reason", "", "text", {
                    required: true,
                    minlength: 3,
                    maxlength: 500,
                  }),
                  field(
                    t("Nur bei Reset: LOGS LÖSCHEN"),
                    "confirmation",
                    "",
                    "text",
                  ),
                  h(
                    "label",
                    { class: "check" },
                    h("input", {
                      type: "checkbox",
                      name: "confirmed",
                      required: true,
                    }),
                    t("Ich bestätige die gewählte Datenbereinigung."),
                  ),
                  h(
                    "button",
                    { type: "submit", class: "btn" },
                    t("Aktion ausführen"),
                  ),
                ),
              ),
            ]
          : h(
              "p",
              { class: "muted" },
              t(
                "Die Aufbewahrung und Datenbereinigung kann nur ein Owner konfigurieren.",
              ),
            ),
      ),
    ];
  }
  submit(form) {
    const data = Object.fromEntries(new FormData(form));
    data.confirmed = form.elements.confirmed.checked;
    if (form.dataset.form === "saveLogRetention") {
      data.enabled = form.elements.enabled.checked;
      for (const k of ["revision", "days", "maxEvents", "intervalHours"])
        data[k] = Number(data[k]);
    }
    this.emit(form.dataset.form, "", "", data);
  }
}
register("x-cuo-log-retention", XCUOLogRetention);
