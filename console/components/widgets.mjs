import {
  Widget,
  register,
  h,
  icon,
  button,
  patch,
  modeLabel,
  stageLabel,
  formatDate,
  field,
  select,
} from "./base.mjs";
import "./container-icon.mjs";
import { tableSort, sortRows, timestamp, duration } from "./table-sorting.mjs";
function sortHeader(column, state, table) {
  const active = column.key === state.key;
  const descendingNext = active
    ? state.direction === "asc"
    : table === "history" && column.key === "createdAt";
  const action = `${column.label}: ${descendingNext ? "absteigend" : "aufsteigend"} sortieren`;
  return h(
    "th",
    {
      scope: "col",
      "aria-sort": active
        ? state.direction === "desc"
          ? "descending"
          : "ascending"
        : null,
    },
    h(
      "button",
      {
        class: "sort",
        type: "button",
        "aria-label": action,
        title: action,
        "data-kind": "sort",
        "data-value": column.key,
        "data-id": table,
      },
      h("span", {}, column.label),
      h("x-icon", {
        name: active
          ? state.direction === "desc"
            ? "chevron-down"
            : "chevron-up"
          : "sort",
        pack: active ? "core" : "cuo",
        size: "12px",
        decorative: true,
      }),
    ),
  );
}
function status(c) {
  return c.candidate?.error
    ? ["Prüfung fehlgeschlagen", "warning"]
    : c.excluded
      ? ["Ausgeschlossen", "muted"]
      : c.candidate?.targetDigest
        ? ["Update verfügbar", "warning"]
        : c.candidate
          ? ["Aktuell", "good"]
          : ["Noch nicht geprüft", "muted"];
}
function version(image) {
  return image.includes("@")
    ? image.split("@")[1].slice(0, 19)
    : image.split(":").pop();
}
function smallDigest(d) {
  return d?.startsWith("sha256:") ? d.slice(0, 19) + "…" : d || "–";
}
export class XUpdateStatusBadge extends Widget {
  render() {
    const c = this.vm.container || {};
    const [label, tone] = status(c);
    return [h("span", { class: "badge " + tone }, label)];
  }
}
register("x-update-status-badge", XUpdateStatusBadge);
export class XContainerTable extends Widget {
  render() {
    const vm = this.vm;
    const sorting = tableSort(vm, "containers");
    const columns = [
      { key: "name", label: "Name", value: (c) => c.name },
      {
        key: "image",
        label: "Image",
        value: (c) => c.image.split("/").pop().split(/[:@]/)[0],
      },
      {
        key: "currentVersion",
        label: "Aktuelle Version",
        value: (c) => version(c.image),
      },
      {
        key: "availableVersion",
        label: "Verfügbare Version",
        value: (c) => c.candidate?.targetDigest,
      },
      { key: "status", label: "Status", value: (c) => status(c)[0] },
      {
        key: "mode",
        label: "Richtlinie",
        value: (c) => modeLabel[c.mode] || c.mode,
      },
    ];
    let rows = (vm.containers || []).filter((c) => {
      const matches = (c.name + " " + c.image)
        .toLowerCase()
        .includes((vm.query || "").toLowerCase());
      return (
        matches &&
        (vm.filter === "all" ||
          (vm.filter === "updates" && c.candidate?.targetDigest) ||
          (vm.filter === "current" &&
            c.candidate &&
            !c.candidate.error &&
            !c.candidate.targetDigest &&
            !c.excluded) ||
          (vm.filter === "excluded" && c.excluded))
      );
    });
    rows = sortRows(rows, sorting, columns);
    const total = rows.length;
    const offset = Math.min(vm.offset || 0, Math.max(0, total - 1));
    rows = rows.slice(offset, offset + 8);
    const all = (vm.containers || []).length,
      update = (vm.containers || []).filter(
        (c) => c.candidate?.targetDigest,
      ).length,
      excluded = (vm.containers || []).filter((c) => c.excluded).length;
    return [
      h(
        "div",
        { class: "table-tools" },
        h(
          "div",
          {},
          h("h2", {}, "Container"),
          h(
            "p",
            { class: "muted" },
            "Alle überwachten Container und ihr Update-Status.",
          ),
        ),
        h(
          "div",
          { class: "inline" },
          h(
            "label",
            { class: "search" },
            icon("search"),
            h("input", {
              "aria-label": "Container suchen",
              placeholder: "Container suchen ...",
              value: vm.query || "",
              "data-input": "query",
            }),
          ),
          button(
            "",
            "filter",
            vm.filter === "excluded" ? "all" : "excluded",
            "",
            "icon-btn",
            "filter",
          ),
        ),
      ),
      h(
        "div",
        { class: "tabs", role: "group", "aria-label": "Container filtern" },
        [
          ["all", "Alle", vm.demo ? 24 : all],
          ["updates", "Update verfügbar", update],
          [
            "current",
            "Aktuell",
            vm.demo
              ? 18
              : (vm.containers || []).filter(
                  (c) =>
                    c.candidate &&
                    !c.candidate.error &&
                    !c.candidate.targetDigest &&
                    !c.excluded,
                ).length,
          ],
          ["excluded", "Ausgeschlossen", vm.demo ? 4 : excluded],
        ].map(([value, label, count]) =>
          h(
            "button",
            {
              type: "button",
              class: "tab " + (vm.filter === value ? "selected" : ""),
              "data-kind": "filter",
              "data-value": value,
              "aria-pressed": String(vm.filter === value),
            },
            value === "all"
              ? null
              : h("i", {
                  class:
                    "dot " +
                    { updates: "red", current: "green", excluded: "gray" }[
                      value
                    ],
                }),
            label,
            h("span", { class: "count" }, String(count)),
          ),
        ),
      ),
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          {},
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              columns.map((column) =>
                sortHeader(column, sorting, "containers"),
              ),
              h("th", { scope: "col" }, "Aktionen"),
            ),
          ),
          h(
            "tbody",
            {},
            rows.length
              ? rows.map((c) => {
                  const [label, tone] = status(c);
                  const name = c.image.split("/").pop().split(":")[0];
                  return h(
                    "tr",
                    { key: c.id },
                    h(
                      "td",
                      {},
                      h(
                        "div",
                        { class: "container-name" },
                        h("i", {
                          class:
                            "dot " + (c.state === "running" ? "green" : "gray"),
                        }),
                        h("x-container-icon", {
                          image: c.image,
                          theme: vm.theme,
                        }),
                        h(
                          "button",
                          {
                            type: "button",
                            class: "name-link",
                            "data-kind": "details",
                            "data-id": c.id,
                          },
                          h("strong", {}, c.name),
                          h("small", {}, c.group),
                        ),
                      ),
                    ),
                    h("td", { class: "image-ref", title: c.image }, name),
                    h("td", { class: "mono" }, version(c.image)),
                    h(
                      "td",
                      {
                        class: c.candidate?.targetDigest
                          ? "available " +
                            (c.updateTone === "critical"
                              ? "critical"
                              : "positive")
                          : "muted",
                      },
                      c.candidate?.targetDigest
                        ? "› " + smallDigest(c.candidate.targetDigest)
                        : "–",
                    ),
                    h(
                      "td",
                      {},
                      h("x-update-status-badge", {
                        "data-view": JSON.stringify({ container: c }),
                      }),
                    ),
                    h("td", {}, modeLabel[c.mode] || c.mode),
                    h(
                      "td",
                      {},
                      button("", "details", "", c.id, "more", "more"),
                    ),
                  );
                })
              : h(
                  "tr",
                  {},
                  h(
                    "td",
                    { colspan: 7, class: "empty" },
                    vm.query
                      ? "Keine Container gefunden."
                      : "Noch keine Container. Docker-Inventar aktualisieren.",
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
          total
            ? `${offset + 1}–${Math.min(offset + 8, total)} von ${vm.demo ? 24 : total} Containern`
            : "0 Container",
        ),
        h(
          "div",
          { class: "inline" },
          button(
            "",
            "page",
            String(Math.max(0, offset - 8)),
            "",
            "page-btn",
            "chevron-left",
          ),
          [0, 8, 16]
            .filter((n) => n < total || vm.demo)
            .map((n, i) =>
              h(
                "button",
                {
                  class: "page-btn " + (offset === n ? "selected" : ""),
                  type: "button",
                  "data-kind": "page",
                  "data-value": String(n),
                },
                String(i + 1),
              ),
            ),
          button(
            "",
            "page",
            String(Math.min(Math.max(0, total - 8), offset + 8)),
            "",
            "page-btn",
            "chevron-right",
          ),
        ),
      ),
    ];
  }
}
register("x-container-table", XContainerTable);
export class XMaintenancePlanner extends Widget {
  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.addEventListener(
      "keydown",
      (e) => {
        if (!e.target.matches(".day")) return;
        const days = [...this.shadowRoot.querySelectorAll(".day")],
          index = days.indexOf(e.target);
        let next = index;
        if (e.key === "ArrowLeft") next--;
        else if (e.key === "ArrowRight") next++;
        else if (e.key === "ArrowUp") next -= 7;
        else if (e.key === "ArrowDown") next += 7;
        else if (e.key === "Home") next -= index % 7;
        else if (e.key === "End") next += 6 - (index % 7);
        else return;
        e.preventDefault();
        days[Math.max(0, Math.min(days.length - 1, next))]?.focus();
      },
      { signal: this.controller.signal },
    );
  }

  render() {
    const vm = this.vm;
    if (!vm.calendar) return [];
    const [y, m] = vm.calendar.split("-").map(Number);
    const first = new Date(y, m - 1, 1),
      offset = (first.getDay() + 6) % 7;
    const month = first.toLocaleDateString("de-DE", {
      month: "long",
      year: "numeric",
    });
    const shift = (n) => {
      const d = new Date(y, m - 1 + n, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    };
    const days = [];
    for (
      let i = 0;
      i < Math.ceil((offset + new Date(y, m, 0).getDate()) / 7) * 7;
      i++
    ) {
      const day = new Date(y, m - 1, 1 - offset + i),
        date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const planned = vm.demo
        ? [5, 8, 15, 22, 29].includes(day.getDate())
        : (vm.windows || []).some(
            (w) =>
              w.enabled &&
              w.days.includes(day.getDay()) &&
              !w.blackouts?.includes(date),
          );
      days.push(
        h(
          "div",
          { class: "calendar-cell" },
          h(
            "button",
            {
              type: "button",
              class: `day${day.getMonth() !== m - 1 ? " outside" : ""}${vm.selectedDate === date ? " chosen" : ""}`,
              "data-kind": "date",
              "data-value": date,
              "aria-label":
                day.toLocaleDateString("de-DE", { dateStyle: "full" }) +
                (planned ? ", Wartungsfenster" : ""),
              "aria-pressed": String(vm.selectedDate === date),
            },
            String(day.getDate()),
            planned ? h("i", { class: "calendar-dot" }) : null,
          ),
        ),
      );
    }
    const selected = new Date(vm.selectedDate + "T12:00:00");
    let label = selected.toLocaleDateString("de-DE", { dateStyle: "full" });
    if (vm.demo && vm.selectedDate === "2026-11-02")
      label = "Sonntag, 2. November 2026";
    const windows = vm.windows || [];
    const chosen = windows.find(
      (w) =>
        w.enabled &&
        (vm.demo || w.days.includes(selected.getDay())) &&
        !w.blackouts?.includes(vm.selectedDate),
    );
    return [
      h(
        "div",
        { class: "panel-heading" },
        h("h2", {}, "Wartungsplan"),
        button(
          "Kalender öffnen",
          "navigate",
          "schedule",
          "",
          "btn subtle",
          "calendar",
        ),
      ),
      h(
        "div",
        { class: "month-head" },
        button("", "calendar", shift(-1), "", "icon-btn", "chevron-left"),
        h("strong", {}, month),
        button("", "calendar", shift(1), "", "icon-btn", "chevron-right"),
      ),
      h(
        "div",
        { class: "weekdays" },
        ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((v) => h("span", {}, v)),
      ),
      h("div", { class: "calendar-grid" }, days),
      h(
        "section",
        { class: "window-card" },
        h(
          "div",
          { class: "inline spread" },
          h("h3", {}, label),
          h(
            "span",
            { class: "badge blue" },
            chosen ? "Wartungsfenster" : "Kein Fenster",
          ),
        ),
        h(
          "p",
          { class: "time" },
          icon("clock", "cuo"),
          chosen
            ? `${chosen.start} – ${vm.demo ? "04:00" : chosen.durationMinutes + " Min."} Uhr`
            : "Für diesen Tag ist nichts geplant",
        ),
        h(
          "p",
          { class: "window-description" },
          chosen
            ? `Automatische Updates – Gruppe „${chosen.name}“`
            : "Plane sichere Updates zu einer passenden Zeit.",
        ),
        h(
          "small",
          { class: "muted indent" },
          chosen
            ? `Max. ${(vm.policies || []).find((p) => p.scope === "global")?.concurrency || 1} parallele Updates · Healthcheck erforderlich`
            : "IANA-Zeitzonen · Sommerzeit berücksichtigt",
        ),
        h(
          "div",
          { class: "align-right" },
          button(
            chosen ? "Details anzeigen" : "Fenster erstellen",
            chosen ? "windowDetails" : "window",
            "",
            chosen?.id || "",
            "btn",
            "arrow-right",
          ),
        ),
      ),
    ];
  }
}
register("x-maintenance-planner", XMaintenancePlanner);
export class XUpdateRunTimeline extends Widget {
  render() {
    const vm = this.vm;
    const compact = this.getAttribute("compact") !== null;
    const sorting = tableSort(vm, "history");
    const columns = [
      {
        key: "createdAt",
        label: "Startzeit",
        value: (j) => timestamp(j.createdAt),
        numeric: true,
      },
      { key: "duration", label: "Dauer", value: duration, numeric: true },
      {
        key: "affected",
        label: "Betroffene Container",
        value: (j) => j.count ?? j.name,
      },
      {
        key: "result",
        label: "Ergebnis",
        value: (j) =>
          vm.demo && j.reason ? j.reason : stageLabel[j.state] || j.state,
      },
    ];
    const rows = sortRows(vm.jobs || [], sorting, columns).slice(
      0,
      compact ? 4 : 100,
    );
    return [
      h(
        "div",
        { class: "panel-heading" },
        h("h2", {}, compact ? "Letzte Update-Läufe" : "Update-Läufe"),
        compact
          ? button(
              "Alle anzeigen",
              "navigate",
              "history",
              "",
              "text-btn",
              "arrow-right",
            )
          : null,
      ),
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          { class: "history-table" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              columns.map((column) => sortHeader(column, sorting, "history")),
              h("th", { scope: "col" }, "Aktionen"),
            ),
          ),
          h(
            "tbody",
            {},
            rows.length
              ? rows.map((j) =>
                  h(
                    "tr",
                    { key: j.id },
                    h("td", {}, formatDate(j.createdAt)),
                    h(
                      "td",
                      {},
                      j.duration ||
                        (j.updatedAt
                          ? Math.max(
                              0,
                              Math.round(
                                (new Date(j.updatedAt) -
                                  new Date(j.createdAt)) /
                                  60000,
                              ),
                            ) + " min"
                          : "–"),
                    ),
                    h("td", {}, j.count ?? j.name),
                    h(
                      "td",
                      {},
                      h(
                        "span",
                        {
                          class:
                            "result " +
                            (j.state === "succeeded"
                              ? "positive"
                              : j.state === "failed" ||
                                  j.state === "intervention_required"
                                ? "critical"
                                : ""),
                        },
                        icon(
                          j.state === "succeeded"
                            ? "success"
                            : j.state === "failed" ||
                                j.state === "intervention_required"
                              ? "error"
                              : "clock",
                          j.state === "pending_approval" ? "cuo" : "core",
                        ),
                        j.reason && vm.demo
                          ? j.reason
                          : stageLabel[j.state] || j.state,
                      ),
                    ),
                    h(
                      "td",
                      {},
                      j.state === "pending_approval"
                        ? button("Freigeben", "approve", "", j.id, "btn small")
                        : ["queued", "scheduled"].includes(j.state)
                          ? button("Abbrechen", "cancel", "", j.id, "btn small")
                          : button(
                              "",
                              "details",
                              "",
                              j.containerId || j.id,
                              "more",
                              "more",
                            ),
                    ),
                  ),
                )
              : h(
                  "tr",
                  {},
                  h(
                    "td",
                    { colspan: 5, class: "empty" },
                    "Noch keine Update-Läufe. Neue Jobs erscheinen hier.",
                  ),
                ),
          ),
        ),
      ),
      !compact
        ? h(
            "div",
            { class: "timeline-notes" },
            rows.slice(0, 6).map((j) =>
              h(
                "article",
                { class: "job-card", key: j.id },
                h("strong", {}, j.name || j.id),
                h(
                  "span",
                  { class: "badge blue" },
                  stageLabel[j.state] || j.state,
                ),
                h("p", { class: "muted" }, j.reason || "Update-Job"),
                h("code", {}, j.id),
                h(
                  "ol",
                  { class: "stages" },
                  [
                    "queued",
                    "preflight",
                    "pulling",
                    "recreating",
                    "verifying",
                    "succeeded",
                  ].map((state) =>
                    h(
                      "li",
                      { class: j.state === state ? "active" : "" },
                      stageLabel[state],
                    ),
                  ),
                ),
              ),
            ),
          )
        : null,
    ];
  }
}
register("x-update-run-timeline", XUpdateRunTimeline);
export class XLogStream extends Widget {
  render() {
    const vm = this.vm;
    return [
      h(
        "div",
        { class: "panel-heading" },
        h("h2", {}, "Systemaktivität (Live)"),
        button(vm.live ? "Aktuell" : "Pausiert", "live", "", "", "live-toggle"),
      ),
      h(
        "div",
        {
          class: "log-screen",
          role: "log",
          "aria-live": vm.live ? "polite" : "off",
          "aria-label": "CUO Systemaktivität",
        },
        (vm.events || [])
          .filter((e) =>
            String(e.message)
              .toLowerCase()
              .includes((vm.query || "").toLowerCase()),
          )
          .slice(this.hasAttribute("expanded") ? -200 : -12)
          .map((e) =>
            h(
              "div",
              { class: "log-line", key: e.id },
              h(
                "time",
                {},
                vm.demo
                  ? new Date(e.time).toLocaleTimeString("de-DE")
                  : formatDate(e.time),
              ),
              h(
                "span",
                {
                  class:
                    e.severity === "error"
                      ? "critical"
                      : e.severity === "warning"
                        ? "warning-text"
                        : "log-info",
                },
                String(e.severity || "info").toUpperCase(),
              ),
              h("span", {}, e.message),
            ),
          ),
        !(vm.events || []).length
          ? h("div", { class: "empty" }, "Warte auf Systemereignisse …")
          : null,
      ),
    ];
  }
}
register("x-log-stream", XLogStream);
export class XPolicyEditor extends Widget {
  render() {
    const vm = this.vm;
    return [
      h(
        "div",
        { class: "panel-heading" },
        h(
          "div",
          {},
          h("h2", {}, "Update-Richtlinien"),
          h(
            "p",
            { class: "muted" },
            "Global → Host → Gruppe → Container. Ausschlüsse bleiben wirksam.",
          ),
        ),
        button("Richtlinie anlegen", "policy", "", "", "btn primary", "plus"),
      ),
      h(
        "div",
        { class: "policy-list" },
        (vm.policies || []).map((p) =>
          h(
            "article",
            { class: "policy-card", key: p.id },
            h(
              "div",
              { class: "policy-heading" },
              h("strong", { class: "policy-title", title: p.id }, p.id),
              h(
                "span",
                { class: "badge " + (p.excluded ? "muted" : "blue") },
                p.excluded ? "Ausgeschlossen" : modeLabel[p.mode],
              ),
            ),
            h(
              "p",
              { class: "muted" },
              `${p.scope} · ${(p.scope === "container" ? (vm.containers || []).find((c) => c.id === p.target)?.name : p.scope === "host" ? (vm.hosts || []).find((host) => host.id === p.target)?.name : "") || p.target || "Alle Container"}`,
            ),
            h(
              "p",
              {},
              "Wartungsfenster: " +
                ((vm.windows || []).find((window) => window.id === p.windowId)
                  ?.name ||
                  p.windowId ||
                  "Keines"),
            ),
            button("Bearbeiten", "policy", "", p.id, "btn"),
            h(
              "p",
              { class: "muted small" },
              `Parallelität: max. ${p.concurrency || 1}`,
            ),
            p.permissions?.readOnlyHostMonitoring
              ? h(
                  "p",
                  { class: "small" },
                  "Owner-Freigabe: lesendes Host-Monitoring",
                )
              : null,
          ),
        ),
      ),
      h(
        "p",
        { class: "callout" },
        "Ausführung benötigt zusätzlich cuo.managed=true am Container. Die globale Standardeinstellung ist „Nur prüfen“.",
      ),
    ];
  }
}
register("x-policy-editor", XPolicyEditor);
export class XHostHealth extends Widget {
  render() {
    const vm = this.vm;
    const compact = this.getAttribute("compact") !== null;
    if (compact)
      return [
        h(
          "div",
          { class: "core-heading" },
          h("i", { class: "dot green" }),
          h("strong", {}, "CUO Core"),
          h("span", {}, "v0.1.0"),
        ),
        h(
          "div",
          { class: "core-line" },
          icon("docker", "cuo"),
          h("span", {}, "Docker"),
          h(
            "b",
            {},
            vm.hosts?.some((h) => h.connected !== false)
              ? "Verbunden"
              : "Getrennt",
          ),
        ),
        h(
          "div",
          { class: "core-line" },
          icon("shield"),
          h("span", {}, "Anmeldung"),
          h(
            "b",
            {},
            vm.oidc?.enabled
              ? vm.oidc.localLoginEnabled === false
                ? "Nur SSO"
                : "SSO + lokal"
              : "Lokal",
          ),
        ),
        h(
          "div",
          { class: "core-line" },
          icon("database", "lucide"),
          h("span", {}, "Datenbank"),
          h("b", {}, "OK"),
        ),
        h(
          "div",
          { class: "core-line core-bottom" },
          icon("shield"),
          h("span", {}, "Systemzustand"),
          h(
            "b",
            {},
            vm.hosts?.some((h) => h.connected === false) ? "Prüfen" : "Gesund",
          ),
        ),
      ];
    return [
      h("h2", {}, "Docker-Hosts"),
      ...(vm.hosts || []).map((host) =>
        h(
          "article",
          { class: "host-card" },
          h(
            "div",
            { class: "inline" },
            icon("server", "lucide"),
            h("h3", {}, host.name),
            h(
              "span",
              { class: "badge " + (host.connected ? "good" : "warning") },
              host.connected ? "Verbunden" : "Nicht erreichbar",
            ),
          ),
          h(
            "p",
            { class: "muted" },
            "Docker-Zugriff über den internen CUO-Agent. Socket bleibt innerhalb der Ausführungsgrenze.",
          ),
          h("code", {}, host.endpoint || "constrained-agent"),
          h(
            "p",
            { class: "muted" },
            `Docker ${host.dockerVersion || "–"} · API ${host.apiVersion || "–"}`,
          ),
          h(
            "div",
            { class: "capabilities" },
            (host.capabilities || []).map((c) =>
              h("span", { class: "badge blue" }, c),
            ),
          ),
        ),
      ),
      button("Inventar aktualisieren", "discover", "", "", "btn", "refresh"),
    ];
  }
}
register("x-host-health", XHostHealth);
