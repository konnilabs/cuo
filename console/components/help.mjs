import { h } from "./base.mjs";
let request;
export function loadNotices() {
  request ||= fetch("/assets/third-party-notices.json", {
    signal: AbortSignal.timeout(10000),
  }).then(async (response) => {
    if (!response.ok) throw Error("Notices unavailable");
    const data = await response.json();
    if (
      data.schema !== "cuo.notices.v1" ||
      !Array.isArray(data.libraries) ||
      data.libraries.length > 100 ||
      typeof data.licenseText !== "string"
    )
      throw Error("Invalid notices");
    return data;
  });
  return request;
}
export function tutorial(notices, state) {
  const steps = [
    [
      "Registries & GitHub",
      "Unter Registries verbindest du universelle OCI-Quellen und optional Zot mit getrennten Pull-/Push-Zugängen. Unter Integrationen → GitHub richtest du deine eigene GitHub-App ein. Subscriptions ordnen vollständige Publish-Releases deinen Containern zu; lokal läuft zusätzlich ein periodischer API-Abgleich.",
    ],
    [
      "Rollenberechtigungen",
      "Unter Benutzer → Rollenberechtigungen verwaltet der Owner die tatsächlich wirksamen Aktionsrechte. Host-Grenzen und containerbezogene Ausführungsfreigaben gelten zusätzlich. Bereits zugelassene Operationen laufen zu Ende.",
    ],
    [
      "1. Container erfassen",
      "Unter Container findest du das Docker-Inventar. Nur ausdrücklich mit cuo.managed=true markierte Container lassen sich aktualisieren; CUO-Systemdienste bleiben geschützt.",
    ],
    [
      "2. Updates prüfen",
      "„Jetzt prüfen“ vergleicht die laufenden Images mit der Registry. Suche, Filter und sortierbare Tabellen helfen bei der Auswahl.",
    ],
    [
      "3. Richtlinien festlegen",
      "Unter Richtlinien gelten Vorgaben für Global → Host → Gruppe → Container. Ausschlüsse bleiben wirksam. Lege Wartungsfenster fest und begrenze die Parallelität auf 1 bis 4. Globale, Host- und Gruppengrenzen gelten gemeinsam.",
    ],
    [
      "4. Update-Lauf starten",
      "Wähle einen Container oder als Administrator „Alle auswählen“. Der Sammellauf startet alle ausführbaren bekannten Kandidaten sofort mit deiner ausdrücklichen Freigabe – auch außerhalb von Wartungsfenstern. Nicht verwaltete, ausgeschlossene, nur zu prüfende oder bereits aktive Container werden übersprungen. Einzeljobs beachten die normalen Freigaben und Wartungsfenster.",
    ],
    [
      "5. Fortschritt verfolgen",
      "Unter Updates, Historie und Logs verfolgst du Jobs und Healthchecks. Bei „Eingriff erforderlich“ prüfe Logs und Agent-Journal, bevor du erneut startest. Datenbanken und Volumes bleiben erhalten; sichere wichtige Daten vor Updates.",
    ],
    [
      "6. Workspace anpassen",
      "Im Profil stellst du Name, Icon, Farbschema und Benachrichtigungen ein. Die Glocke öffnet das Notification Center. Der Owner konfiguriert unter Integrationen OIDC und die lokale Anmeldung.",
    ],
  ];
  return [
    h(
      "div",
      { class: "tutorial-steps" },
      steps.map(([title, body]) =>
        h("section", {}, h("h3", {}, title), h("p", { class: "muted" }, body)),
      ),
    ),
    h(
      "section",
      { class: "tutorial-license" },
      h("h3", {}, "Lizenz & Drittanbieter"),
      h(
        "p",
        {},
        "CUO 0.2.0 wird unter der Apache License 2.0 bereitgestellt. Die Anwendung und ihre Ressourcen enthalten Komponenten Dritter mit eigenen Lizenzbedingungen. Produktnamen und Marken gehören ihren jeweiligen Inhabern.",
      ),
      h(
        "a",
        {
          href: "/assets/third-party-notices.json",
          download: "CUO-Lizenzhinweise.json",
        },
        "Vollständige Lizenzhinweise herunterladen",
      ),
      h(
        "div",
        {
          class: "third-party-notices",
          role: "region",
          "aria-label": "Verwendete Drittanbieter-Bibliotheken",
          tabindex: 0,
          "aria-busy": !notices && state !== "failed" ? "true" : "false",
        },
        notices
          ? [
              h(
                "details",
                {},
                h("summary", {}, "CUO · Apache-2.0"),
                h("pre", { class: "license-text" }, notices.licenseText),
                h("pre", { class: "license-text" }, notices.notice),
              ),
              notices.libraries.map((library) =>
                h(
                  "details",
                  {},
                  h(
                    "summary",
                    {},
                    `${library.name} ${library.version} · ${library.license}`,
                  ),
                  h(
                    "a",
                    {
                      href: library.source,
                      target: "_blank",
                      rel: "noopener noreferrer",
                    },
                    "Projekt / Quelle",
                  ),
                  h("pre", { class: "license-text" }, library.text),
                ),
              ),
            ]
          : h(
              "p",
              { class: "muted", role: "status" },
              state === "failed"
                ? "Lizenzliste konnte nicht geladen werden. Lade die Seite neu oder verwende den Download-Link."
                : "Lizenzliste wird geladen …",
            ),
      ),
    ),
  ];
}
