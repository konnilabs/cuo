import { t } from "../i18n/index.mjs";
import { h, button, select } from "./base.mjs";
import { appearance } from "./account.mjs";
export const settingsTabs = [
  ["appearance", "Darstellung"],
  ["accessibility", "Barrierefreiheit"],
  ["language", "Sprache"],
  ["data", "Daten & Sitzung"],
];
export function workspaceSettings(vm) {
  const selected = settingsTabs.some(([id]) => id === vm.settingsTab)
    ? vm.settingsTab
    : "appearance";
  let panel;
  if (selected === "appearance")
    panel = [
      h("h3", {}, t("Darstellung")),
      h(
        "p",
        { class: "muted" },
        t(
          "Wähle eine Farbfamilie. Heller und dunkler Modus funktionieren mit jeder Auswahl.",
        ),
      ),
      appearance(vm),
    ];
  else if (selected === "accessibility")
    panel = [
      h("h3", {}, t("Barrierefreiheit")),
      h(
        "x-toggle",
        {
          label: t("Hoher Kontrast"),
          checked: !!vm.highContrast,
          "data-high-contrast": true,
        },
        h("span", { slot: "on-label" }, t("Ein")),
        h("span", { slot: "off-label" }, t("Aus")),
      ),
      h(
        "p",
        { class: "muted" },
        t(
          "Verstärkt Text, Konturen und Fokusmarkierungen in der gesamten Shell, einschließlich Dialogen und Tabellen.",
        ),
      ),
      h(
        "p",
        { class: "callout" },
        t(
          "Die Shell unterstützt Tastaturnavigation und berücksichtigt reduzierte Bewegung sowie erzwungene Systemfarben.",
        ),
      ),
    ];
  else if (selected === "language")
    panel = [
      h("h3", {}, t("Sprache")),
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          checked: vm.languageAutomatic !== false,
          "data-auto-language": true,
        }),
        t("Sprache automatisch vom Browser übernehmen"),
      ),
      select(
        t("Anzeigesprache"),
        "language",
        vm.languageAutomatic !== false
          ? vm.locale || "de"
          : vm.language || "de",
        [
          ["de", t("Deutsch")],
          ["en", t("English")],
        ],
      ),
      h(
        "p",
        { class: "muted" },
        vm.languageAutomatic !== false
          ? t(
              "Die erste unterstützte Browsersprache wird verwendet. Für andere Sprachen wird Englisch angezeigt.",
            )
          : t("Die manuelle Sprache wird in deinem Profil gespeichert."),
      ),
      h(
        "p",
        { class: "muted" },
        t(
          "Container-Namen, Image-Referenzen und gespeicherte Logs behalten ihren Originaltext.",
        ),
      ),
    ];
  else
    panel = [
      h("h3", {}, t("Lokale Installation")),
      h("p", {}, t("CUO 0.3.1 · Go Core · XTend Maraca / RMT")),
      h(
        "p",
        { class: "muted" },
        t(
          "SQLite-Speicher und Agent-Journale liegen in persistenten Docker-Volumes.",
        ),
      ),
      h("x-cuo-log-retention"),
      h("h3", {}, t("Sitzung")),
      h("p", {}, vm.user?.name + " · " + vm.user?.role),
      button(t("Abmelden"), "logout", "", "", "btn"),
    ];
  // Select props stay explicit and are owned by the RMT view model.
  if (selected === "language") {
    const choice = panel.find(
      (item) =>
        item?.tag === "label" && item.children?.some((c) => c.tag === "select"),
    );
    if (choice) {
      const input = choice.children.find((c) => c.tag === "select");
      input.attrs["data-language"] = true;
      input.attrs.disabled = vm.languageAutomatic !== false;
    }
  }
  return [
    h("h2", {}, t("Workspace-Einstellungen")),
    h(
      "div",
      {
        role: "tablist",
        "aria-label": t("Einstellungsbereiche"),
        class: "settings-tabs",
      },
      settingsTabs.map(([id, label]) =>
        h(
          "button",
          {
            type: "button",
            key: id,
            id: "settings-tab-" + id,
            role: "tab",
            "aria-selected": String(id === selected),
            "aria-controls": "settings-panel-" + id,
            tabindex: id === selected ? 0 : -1,
            "data-kind": "settingsTab",
            "data-value": id,
            class: "settings-tab",
          },
          t(label),
        ),
      ),
    ),
    h(
      "section",
      {
        role: "tabpanel",
        id: "settings-panel-" + selected,
        "aria-labelledby": "settings-tab-" + selected,
        tabindex: 0,
        class: "settings-content",
      },
      panel,
    ),
  ];
}
export function bindSettingsTabs(widget) {
  widget.shadowRoot.addEventListener(
    "keydown",
    (event) => {
      const button = event.target.closest('[role="tab"]');
      if (
        !button ||
        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
      )
        return;
      const tabs = [...widget.shadowRoot.querySelectorAll('[role="tab"]')];
      let index = tabs.indexOf(button);
      index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length;
      event.preventDefault();
      tabs[index].focus();
      widget.emit("settingsTab", tabs[index].dataset.value);
    },
    { signal: widget.controller.signal },
  );
}
