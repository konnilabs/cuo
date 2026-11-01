import type { VM } from "./contracts.ts";
import { notifications } from "./notifications.ts";
export const pageNames: Record<string, string> = {
  dashboard: "Dashboard",
  containers: "Container",
  updates: "Updates",
  schedule: "Zeitplanung",
  policies: "Richtlinien",
  history: "Historie",
  logs: "Logs",
  settings: "Einstellungen",
  hosts: "Hosts",
  users: "Benutzer",
  integrations: "Integrationen",
};
const descriptions: Record<string, string> = {
  dashboard: "Übersicht über deine Container, Updates und den Systemstatus.",
  containers: "Alle überwachten Container und ihr Update-Status.",
  updates: "Verfügbare Updates prüfen, freigeben und ausführen.",
  schedule: "Wartungsfenster und automatische Updates planen.",
  policies: "Richtlinien für globale, Gruppen- und Container-Einstellungen.",
  history: "Dauerhafte Update-Läufe und ihre Ergebnisse.",
  logs: "Systemaktivität und unveränderliche Audit-Ereignisse.",
  hosts: "Verbindung und Ausführungsgrenze deines Docker-Hosts.",
  users: "Lokale Benutzer, Rollen und Host-Berechtigungen verwalten.",
  settings: "CUO nach deinen Anforderungen konfigurieren.",
  integrations: "Lokale Dienste und optionale Integrationen.",
};
export function initial(): VM {
  return {
    auth: "loading",
    theme: "light",
    themeMode: "system",
    notificationsOpen: false,
    profileOpen: false,
    dismissed: [],
    oidc: {},
    oidcConfig: null,
    page: "dashboard",
    mobile: false,
    notice: "",
    toasts: [],
    error: false,
    demo: false,
    user: { name: "", role: "" },
    containers: [],
    jobs: [],
    events: [],
    policies: [],
    windows: [],
    hosts: [],
    users: [],
    query: "",
    filter: "all",
    sort: "name",
    sortDirection: "asc",
    historySort: "createdAt",
    historySortDirection: "desc",
    offset: 0,
    calendar: new Date().toISOString().slice(0, 7),
    selectedDate: new Date().toISOString().slice(0, 10),
    dialog: "",
    selected: "",
    live: true,
  };
}
export function present(vm: VM): VM {
  const total = vm.containers.length,
    excluded = vm.containers.filter((c) => c.excluded).length,
    updates = vm.containers.filter(
      (c) => c.candidate?.targetDigest && !c.candidate.error,
    ).length;
  const issue =
    vm.hosts.filter((h) => h.connected === false).length +
    vm.jobs.filter((j) => ["intervention_required"].includes(String(j.state)))
      .length;
  const title = pageNames[vm.page] || "Dashboard";
  const auth = vm.auth === "ready" || vm.demo;
  const items = notifications(vm);
  const result: VM = {
    ...vm,
    themeToggleIcon: vm.theme === "dark" ? "sun" : "moon",
    themeToggleLabel:
      vm.theme === "dark"
        ? "Farbschema wechseln: Hellen Modus aktivieren"
        : "Farbschema wechseln: Dunklen Modus aktivieren",
    notifications: items,
    notificationCount: String(items.length),
    notificationClass: items.length ? "notification-count" : "is-hidden",
    notificationsExpanded: String(vm.notificationsOpen),
    profileExpanded: String(vm.profileOpen),
    avatarTextClass:
      !vm.user.profile || vm.user.profile.avatar === "initials"
        ? ""
        : "is-hidden",
    avatarIconClass:
      !vm.user.profile || vm.user.profile.avatar === "initials"
        ? "is-hidden"
        : "",
    avatarName:
      vm.user.profile?.avatar === "initials"
        ? "user"
        : vm.user.profile?.avatar || "user",
    avatarPack: "cuo",
    title,
    description: descriptions[vm.page] || "",
    total: String(total),
    monitored: String(total - excluded),
    excludedCount: String(excluded),
    updateCount: String(updates),
    updateHint: `${updates} Image-Änderungen verfügbar`,
    currentCount: String(
      vm.containers.filter(
        (c) =>
          c.candidate &&
          !c.candidate.error &&
          !c.candidate.targetDigest &&
          !c.excluded,
      ).length,
    ),
    systemTitle: issue ? "Aufmerksamkeit nötig" : "Alles in Ordnung",
    systemDetail: `${issue} Fehler · ${vm.jobs.filter((j) => !["succeeded", "failed", "intervention_required", "cancelled"].includes(String(j.state))).length} ausstehende Jobs`,
    userInitials:
      vm.user.name
        .split(/\s/)
        .map((s) => s[0])
        .join("")
        .slice(0, 2)
        .toUpperCase() || "CU",
    shellClass: `cuo-shell${vm.mobile ? " mobile-open" : ""}${auth ? "" : " is-hidden"}`,
    authClass: auth ? "is-hidden" : "auth-wrap",
    dashboardClass: vm.page === "dashboard" ? "dashboard-grid" : "is-hidden",
    workspaceClass:
      vm.page === "dashboard"
        ? "is-hidden"
        : vm.page === "logs"
          ? "workspace-panel logs-workspace"
          : "workspace-panel",
    mainContentClass:
      vm.page === "logs" ? "main-content logs-page" : "main-content",
    demoClass: vm.demo ? "demo-note" : "is-hidden",
    pageTitle: title,
    nextDate: "Kein Fenster geplant",
    nextTime: "Wartungsfenster erstellen",
  };
  if (vm.windows.length) {
    const w = vm.windows
      .filter((w) => w.enabled && w.nextStart)
      .sort((a, b) =>
        String(a.nextStart).localeCompare(String(b.nextStart)),
      )[0];
    if (w) {
      const start = new Date(String(w.nextStart)),
        end = new Date(start.getTime() + Number(w.durationMinutes) * 60000);
      result.nextDate = start.toLocaleDateString("de-DE", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: String(w.timezone),
      });
      result.nextTime =
        start.toLocaleTimeString("de-DE", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: String(w.timezone),
        }) +
        " – " +
        end.toLocaleTimeString("de-DE", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: String(w.timezone),
        }) +
        " Uhr";
    }
  }
  if (vm.demo) {
    result.updateHint = "2 wichtig · 1 normal";
    result.systemTitle = "Alles in Ordnung";
    result.systemDetail = "Keine Fehler · 0 ausstehende Jobs";
    result.total = "24";
    result.monitored = "20";
    result.excludedCount = "4";
    result.updateCount = "3";
    result.currentCount = "18";
    result.nextDate = "So, 2. Nov. 2026";
    result.nextTime = "03:00 – 04:00 Uhr";
  }
  for (const page of Object.keys(pageNames)) {
    result["nav" + page] =
      `nav-item cuo-action${vm.page === page ? " active" : ""}`;
    result["route" + page] = vm.page === page ? "route-panel" : "is-hidden";
  }
  const { serialized: ignored, ...publicView } = result;
  result.serialized = JSON.stringify(publicView);
  return result;
}
export function demoVM(): VM {
  const vm = initial();
  vm.auth = "ready";
  vm.demo = true;
  vm.sort = "";
  vm.user = { name: "Max Mustermann", role: "Administrator" };
  vm.calendar = "2026-11";
  vm.selectedDate = "2026-11-02";
  const examples = [
    [
      "nextcloud",
      "Produktiv",
      "nextcloud",
      "29.0.7",
      "29.0.8",
      "approval-required",
    ],
    ["nginx-proxy", "Infrastruktur", "nginx", "1.27.2", "1.27.3", "automatic"],
    ["redis", "Cache", "redis", "7.2.5", "", "automatic"],
    ["postgres", "Datenbank", "postgres", "17.1", "", "approval-required"],
    [
      "vaultwarden",
      "Sicherheit",
      "vaultwarden",
      "1.32.4",
      "1.33.0",
      "automatic",
    ],
    ["appsmith", "Tools", "appsmith", "1.23.0", "", "automatic"],
    ["portainer", "Management", "portainer", "2.21.1", "", "automatic"],
    ["immich", "Medien", "immich", "1.124.2", "", "automatic"],
  ];
  vm.containers = examples.map(
    ([name, group, image, version, target, mode], i) => ({
      id: "demo-" + i,
      name,
      group,
      image: image + ":" + version,
      imageId: version,
      state: "running",
      platform: "linux/amd64",
      compose: i % 2 === 0,
      managed: true,
      excluded: false,
      mode,
      reason: "",
      updateTone: i === 0 || i === 4 ? "critical" : "positive",
      candidate: { targetDigest: target, sourceDigest: version },
    }),
  );
  const extras = [
    "syncthing",
    "paperless",
    "jellyfin",
    "grafana",
    "prometheus",
    "mosquitto",
    "homeassistant",
    "traefik",
    "uptime-kuma",
    "gitea",
    "minio",
    "whoami",
    "test-db",
    "legacy-app",
    "backup-worker",
    "sandbox",
  ];
  extras.forEach((name, i) =>
    vm.containers.push({
      id: "demo-extra-" + i,
      name,
      group: i >= 12 ? "Ausgeschlossen" : "Infrastruktur",
      image: name + ":stable",
      imageId: "demo",
      candidate: { targetDigest: "", sourceDigest: "demo" },
      state: "running",
      platform: "linux/amd64",
      compose: true,
      managed: i < 12,
      excluded: i >= 12,
      mode: i >= 12 ? "disabled" : "automatic",
      reason: "",
    }),
  );
  vm.jobs = [
    ["26.10.2026", "12 min", "4", "succeeded", "3 erfolgreich · 1 unverändert"],
    ["19.10.2026", "8 min", "2", "succeeded", "2 erfolgreich"],
    ["12.10.2026", "6 min", "1", "failed", "1 fehlgeschlagen"],
    ["05.10.2026", "11 min", "3", "succeeded", "3 erfolgreich"],
  ].map(([date, duration, count, state, reason], i) => ({
    id: "demo-job-" + i,
    createdAt: date + " 03:00",
    duration,
    count,
    state,
    reason,
    name: "Update-Lauf",
  }));
  vm.events = [
    "Prüfe nextcloud:stable ...",
    "Neues Image verfügbar: 29.0.7 → 29.0.8",
    "Container in Warteschlange (manuelle Freigabe)",
    "Prüfe nginx:stable ...",
    "Neues Image verfügbar: 1.27.2 → 1.27.3",
    "Container in Warteschlange (automatisch)",
    "Prüfe redis:7 ...",
    "Kein Update verfügbar",
    "Prüfe postgres:17 ...",
    "Kein Update verfügbar",
  ].map((message, i) => ({
    id: i,
    time: `2026-11-01T08:14:${String(22 + i).padStart(2, "0")}Z`,
    severity: "info",
    message,
  }));
  vm.policies = [
    {
      id: "global",
      scope: "global",
      target: "",
      mode: "automatic",
      excluded: false,
      concurrency: 1,
      windowId: "standard",
    },
  ];
  vm.windows = [
    {
      id: "standard",
      name: "Standard",
      start: "03:00",
      durationMinutes: 60,
      timezone: "Europe/Berlin",
      days: [1],
      enabled: true,
    },
  ];
  vm.hosts = [
    {
      id: "local",
      name: "Lokaler Docker-Host",
      connected: true,
      capabilities: ["inventory", "registry-scan"],
    },
  ];
  return present(vm);
}
