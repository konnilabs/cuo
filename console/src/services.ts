import { setLocale, t } from "../i18n/index.mjs";
import {
  preferenceDefaults,
  palettes,
  preferredLanguage,
} from "../shared/ui-preferences.mjs";
import { loadProcesses, processIntent } from "./processes.ts";
import {
  integrationIntent,
  loadIntegrations,
  routeDetails,
  cancelIntegrationQueries,
} from "./integrations.ts";
import { defineAppServices, service } from "@ccslabs/xtend-maraca/app-services";
import type { MaracaBrowserFacade } from "@ccslabs/xtend/maraca/browser-composition-runtime";
import type { Intent, Request, VM } from "./contracts.ts";
import { createCUOClient } from "./generated-api.ts";
import { initial, present, demoVM, pageNames } from "./view.ts";
import { applyTableSort } from "../components/table-sorting.mjs";
declare global {
  interface Window {
    XTendMaraca: MaracaBrowserFacade;
  }
}
import type { XRouterElement } from "../.framework/components/xrouter.js";
function routePage(path: string) {
  const page = routeDetails(path).page;
  return Object.hasOwn(pageNames, page) ? page : "dashboard";
}
function currentPage() {
  return routePage(location.hash.replace(/^#/, ""));
}
function theme(vm: VM, mode = vm.themeMode) {
  vm.themeMode = mode;
  vm.theme =
    mode === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : mode;
  return vm;
}
function profile(vm: VM) {
  return {
    displayName: vm.user.name,
    avatar: "initials",
    theme: vm.themeMode,
    updateNotifications: true,
    ...preferenceDefaults,
    ...vm.user.profile,
  };
}
async function applyPreferences(vm: VM, data = profile(vm)) {
  theme(vm, String(data.theme || "system"));
  vm.palette = palettes.includes(data.palette) ? data.palette : "slate";
  vm.highContrast = data.highContrast === true;
  vm.language = data.language === "en" ? "en" : "de";
  vm.languageAutomatic = data.languageAutomatic !== false;
  vm.locale = vm.languageAutomatic
    ? preferredLanguage(
        navigator.languages?.length
          ? navigator.languages
          : [navigator.language],
      )
    : vm.language;
  await setLocale(vm.locale);
  return vm;
}
const sidebarPreferenceKey = "cuo.sidebar.collapsed";
function sidebarPreference(narrow: boolean) {
  // A phone starts with its icon rail; opening it is a temporary overlay.
  if (narrow) return true;
  try {
    return localStorage.getItem(sidebarPreferenceKey) === "true";
  } catch {
    return false;
  }
}
function rememberSidebar(collapsed: boolean) {
  try {
    localStorage.setItem(sidebarPreferenceKey, String(collapsed));
  } catch {
    // Navigation remains usable when browser storage is unavailable.
  }
}
async function preference(vm: VM, changes: Record<string, unknown>) {
  const data = { ...profile(vm), ...changes };
  if (vm.demo) {
    localStorage.setItem("cuo.demo.profile", JSON.stringify(data));
    vm.user = { ...vm.user, name: String(data.displayName), profile: data };
  } else {
    const result = await api("/auth/profile", "POST", data);
    vm.user = {
      ...vm.user,
      name: result.profile.displayName,
      profile: result.profile,
    };
  }
  return applyPreferences(vm, profile(vm));
}
function observePreferences() {
  const boundary = window.XTendMaraca.getSurfaceBoundary();
  window.addEventListener(
    "languagechange",
    () => {
      void window.XTendMaraca.dispatchCommand("cuo.intent", {
        kind: "systemLanguage",
      }).catch(() => {});
    },
    { signal: boundary.signal },
  );
  const media = matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener(
    "change",
    () => {
      void window.XTendMaraca.dispatchCommand("cuo.intent", {
        kind: "systemTheme",
      }).catch(() => {});
    },
    { signal: boundary.signal },
  );
  matchMedia("(max-width: 760px)").addEventListener(
    "change",
    (event) => {
      void window.XTendMaraca.dispatchCommand("cuo.intent", {
        kind: "sidebarViewport",
        value: String(event.matches),
      }).catch(() => {});
    },
    { signal: boundary.signal },
  );
}
// Resource handles only; all application, navigation and filter state lives in RMT.
let stream: EventSource | undefined,
  refreshTimer: ReturnType<typeof setTimeout> | undefined;
function model() {
  return (window.XTendMaraca.model?.getState("cuo.vm") as VM) || initial();
}
async function api(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
  signal?: AbortSignal,
) {
  const csrf = await fetch("/auth/session", {
    credentials: "same-origin",
  }).then((r) => r.json());
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (method !== "GET") {
    headers["X-CSRF-Token"] = csrf.csrf || "";
    headers["Idempotency-Key"] = key || crypto.randomUUID();
  }
  const r = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok)
    throw Error(data.message || data.error || t("Anfrage fehlgeschlagen"));
  return data;
}
const coreClient = createCUOClient({
  async request<T>(method: string, path: string, body?: unknown, key?: string) {
    return (await api(path, method, body, key)) as T;
  },
});
async function snapshot(vm: VM, discover = false): Promise<VM> {
  const session = await api("/auth/session");
  vm.auth = session.enrollment ? "enroll" : session.user ? "ready" : "login";
  vm.user = session.user || { name: "", role: "" };
  vm.oidc = session.oidc || {};
  vm.dismissed = session.dismissed || [];
  await applyPreferences(vm, profile(vm));
  if (vm.user.role === "Owner") vm.oidcConfig = await api("/auth/oidc/config");
  else vm.oidcConfig = null;
  if (vm.auth !== "ready") return present(vm);
  const paths = [
    "containers" + (discover ? "?refresh=true" : ""),
    "update-jobs",
    "policies",
    "maintenance-windows",
    "hosts",
    "activity",
  ];
  vm = await loadIntegrations(vm, api);
  const data = await Promise.all(
    paths.map((p) =>
      vm.user.role === "Owner" ||
      (vm.capabilities as string[]).includes("inventory.read")
        ? api("/api/v1/" + p)
        : Promise.resolve({ items: [] }),
    ),
  );
  const [containers, jobs, policies, windows, hosts, events] = data;
  let users = vm.users;
  if (
    vm.user.role === "Owner" ||
    (vm.capabilities as string[]).includes("users.manage")
  )
    users = (await api("/auth/users")).items;
  return present(
    await loadProcesses(
      {
        ...vm,
        containers: containers.items || [],
        jobs: jobs.items || [],
        policies: policies.items || [],
        windows: windows.items || [],
        hosts: hosts.items || [],
        events: (events.items || []).slice(-200),
        users,
      },
      api,
    ),
  );
}
function connect() {
  if (
    stream ||
    model().demo ||
    (model().user.role !== "Owner" &&
      !(model().capabilities as string[]).includes("inventory.read"))
  )
    return;
  const boundary = window.XTendMaraca.getSurfaceBoundary();
  if (boundary.signal.aborted) return;
  stream = new EventSource("/api/v1/events");
  stream.addEventListener("activity", () => {
    if (!model().live || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void window.XTendMaraca.dispatchCommand("cuo.intent", {
        kind: "refresh",
      }).catch(() => {});
    }, 400);
  });
  boundary.signal.addEventListener(
    "abort",
    () => {
      stream?.close();
      stream = undefined;
      if (refreshTimer) clearTimeout(refreshTimer);
    },
    { once: true },
  );
}
async function intent(input: Intent): Promise<{ vm: VM }> {
  let vm: VM = { ...model(), notice: "", error: false };
  const { kind, value = "", id = "", data = {} } = input || { kind: "" };
  try {
    const integration = await integrationIntent(vm, input, {
      api,
      refresh: snapshot,
    });
    if (integration) vm = integration;
    else if (kind === "boot") {
      observePreferences();
      await applyPreferences(vm);
      const sidebarNarrow = matchMedia("(max-width: 760px)").matches;
      const sidebar = {
        sidebarNarrow,
        sidebarCollapsed: sidebarPreference(sidebarNarrow),
      };
      Object.assign(vm, sidebar);
      Object.assign(vm, routeDetails(location.hash.replace(/^#/, "")));
      vm.page = currentPage();
      if (new URL(location.href).searchParams.get("demo") === "1") {
        vm = demoVM();
        Object.assign(vm, sidebar);
        Object.assign(vm, routeDetails(location.hash.replace(/^#/, "")));
        vm.page = currentPage();
        try {
          const data = JSON.parse(
            localStorage.getItem("cuo.demo.profile") || "null",
          );
          if (data)
            vm.user = { ...vm.user, name: data.displayName, profile: data };
        } catch {}
        return { vm: present(await applyPreferences(vm)) };
      }
      vm = await snapshot(vm, true);
      if (new URL(location.href).searchParams.get("login_error") === "oidc") {
        vm.notice =
          vm.oidc.localLoginEnabled === false
            ? t(
                "SSO-Anmeldung fehlgeschlagen oder abgelaufen. Bitte erneut versuchen oder den Betreiber kontaktieren.",
              )
            : t(
                "SSO-Anmeldung fehlgeschlagen oder abgelaufen. Bitte erneut versuchen oder lokal anmelden.",
              );
        vm.error = true;
      }
      const githubSetup = new URL(location.href).searchParams.get(
        "github_setup",
      );
      if (githubSetup) {
        vm.notice =
          githubSetup === "success"
            ? t(
                "GitHub-Einrichtung abgeschlossen. Installation und Verbindung prüfen.",
              )
            : t(
                "GitHub-Einrichtung fehlgeschlagen oder abgelaufen. Bitte erneut starten.",
              );
        vm.error = githubSetup !== "success";
      }
      if (vm.auth === "ready") connect();
    } else if (kind === "refresh") {
      if (!vm.demo) {
        vm = await snapshot(vm);
        if (vm.auth === "ready") connect();
      }
    } else if (kind === "navigate") {
      const route = routeDetails("/" + value);
      if (!Object.hasOwn(pageNames, route.page))
        throw Error(t("Unbekannte Ansicht"));
      cancelIntegrationQueries();
      const router = document.getElementById(
        "cuo-router",
      ) as XRouterElement | null;
      if (!router?.navigate("/" + value))
        throw Error(t("Navigation ist noch nicht bereit"));
      Object.assign(vm, route);
      vm.integrationQueryBusy = false;
      vm.integrationRequest = "";
      vm.page = route.page;
      if (vm.sidebarNarrow) vm.sidebarCollapsed = true;
      vm.dialog = "";
      vm.notificationsOpen = false;
      if (!vm.demo && vm.auth === "ready") {
        vm = await loadIntegrations(vm, api);
        vm = await loadProcesses(vm, api);
      }
    } else if (kind === "route") {
      cancelIntegrationQueries();
      Object.assign(vm, routeDetails(value));
      vm.integrationQueryBusy = false;
      vm.integrationRequest = "";
      vm.page = routePage(value);
      if (vm.sidebarNarrow) vm.sidebarCollapsed = true;
      vm.dialog = "";
      vm.notificationsOpen = false;
      if (!vm.demo && vm.auth === "ready") {
        vm = await loadIntegrations(vm, api);
        vm = await loadProcesses(vm, api);
      }
    } else if (kind === "containerTab") {
      if (["overview", "source", "permissions"].includes(value))
        vm.containerTab = value;
    } else if (kind === "settingsTab") {
      if (["appearance", "accessibility", "language", "data"].includes(value))
        vm.settingsTab = value;
    } else if (kind === "palette") {
      if (!palettes.includes(value)) throw Error(t("Ungültige Farbfamilie"));
      vm = await preference(vm, { palette: value });
    } else if (kind === "highContrast") {
      vm = await preference(vm, { highContrast: value === "true" });
    } else if (kind === "language") {
      if (!["de", "en"].includes(value)) throw Error(t("Ungültige Sprache"));
      vm = await preference(vm, { language: value, languageAutomatic: false });
    } else if (kind === "languageAuto") {
      vm = await preference(vm, {
        languageAutomatic: value === "true",
        language: vm.locale,
      });
    } else if (kind === "systemLanguage") {
      await applyPreferences(vm);
    } else if (kind === "theme") {
      vm = await preference(vm, {
        theme: vm.theme === "dark" ? "light" : "dark",
      });
    } else if (kind === "themeAuto") {
      vm = await preference(vm, {
        theme: value === "true" ? "system" : vm.theme,
      });
    } else if (kind === "themeSet") {
      vm = await preference(vm, { theme: value === "true" ? "dark" : "light" });
    } else if (kind === "systemTheme") {
      theme(vm);
    } else if (kind === "notifications") {
      vm.notificationsOpen = !vm.notificationsOpen;
    } else if (kind === "closeNotifications") {
      vm.notificationsOpen = false;
    } else if (
      kind === "dismissNotification" ||
      kind === "clearNotifications"
    ) {
      const items = (vm.notifications || []) as { id: string }[];
      const ids =
        kind === "clearNotifications"
          ? items.map((n) => n.id)
          : items.filter((n) => n.id === id).map((n) => n.id);
      if (vm.demo) vm.dismissed = [...vm.dismissed, ...ids];
      else
        vm.dismissed = (
          await api("/auth/notifications/dismiss", "POST", { ids })
        ).dismissed;
    } else if (kind === "dismissToast") {
      vm.toasts = vm.toasts.filter((toast) => toast.id !== id);
    } else if (kind === "profile") {
      vm.profileOpen = true;
      vm.notificationsOpen = false;
    } else if (kind === "closeProfile") {
      vm.profileOpen = false;
    } else if (kind === "saveProfile") {
      vm = await preference(vm, data);
      vm.notice = t("Profil gespeichert.");
    } else if (kind === "oidcLogin") {
      location.assign("/auth/oidc/start");
    } else if (kind === "sidebarToggle") {
      vm.sidebarCollapsed = !vm.sidebarCollapsed;
      if (!vm.sidebarNarrow) rememberSidebar(vm.sidebarCollapsed);
    } else if (kind === "sidebarClose") {
      vm.sidebarCollapsed = true;
    } else if (kind === "sidebarViewport") {
      vm.sidebarNarrow = value === "true";
      vm.sidebarCollapsed = sidebarPreference(vm.sidebarNarrow);
    } else if (
      kind.startsWith("process") ||
      [
        "downloadData",
        "exportData",
        "saveLogRetention",
        "logMaintenance",
      ].includes(kind)
    ) {
      vm = (await processIntent(vm, input, api)) || vm;
    } else if (kind === "filter") {
      vm.filter = value;
      vm.offset = 0;
    } else if (kind === "query") {
      vm.query = value.slice(0, 160);
      vm.offset = 0;
    } else if (kind === "sort") vm = applyTableSort(vm, id, value);
    else if (kind === "page") vm.offset = Math.max(0, Number(value) || 0);
    else if (kind === "calendar") {
      vm.calendar = value;
      vm.selectedDate = value + "-01";
    } else if (kind === "date") vm.selectedDate = value;
    else if (kind === "live") vm.live = !vm.live;
    else if (kind === "close") {
      vm.dialog = "";
      vm.selected = "";
    } else if (kind === "details") {
      vm.dialog = "container";
      vm.selected = id;
    } else if (
      [
        "add",
        "window",
        "windowDetails",
        "run",
        "help",
        "exclude",
        "policy",
        "approve",
        "cancel",
        "user",
      ].includes(kind)
    ) {
      vm.dialog = kind;
      vm.selected = id;
    } else if (kind === "demo") return { vm: demoVM() };
    else if (kind === "exitDemo") {
      location.assign("/");
      return { vm: present(vm) };
    } else {
      if (vm.demo)
        throw Error(
          t(
            "Design-Demo: Änderungen sind deaktiviert. Zur Live-Ansicht wechseln.",
          ),
        );
      if (kind === "login" || kind === "enroll") {
        await api("/auth/" + kind, "POST", data);
        vm = await snapshot(vm, true);
        connect();
      } else if (kind === "logout") {
        await api("/auth/logout", "POST", {});
        stream?.close();
        stream = undefined;
        vm = await snapshot(initial());
      } else if (kind === "saveOIDC") {
        vm.oidcConfig = await api("/auth/oidc/config", "POST", data);
        vm.oidc = {
          enabled: vm.oidcConfig!.enabled,
          label: vm.oidcConfig!.label,
          localLoginEnabled: vm.oidcConfig!.localLoginEnabled,
        };
        vm.notice = t("OIDC-Konfiguration gespeichert und Discovery geprüft.");
      } else if (kind === "scan") {
        await coreClient.scan(crypto.randomUUID());
        vm.notice = t("Update-Prüfung gestartet. Ergebnisse erscheinen live.");
        connect();
      } else if (kind === "saveWindow") {
        await api("/api/v1/maintenance-windows", "POST", data);
        vm.dialog = "";
        vm = await snapshot(vm);
        vm.notice = t("Wartungsfenster angelegt.");
      } else if (kind === "savePolicy") {
        await api("/api/v1/policies/" + encodeURIComponent(id), "PUT", data);
        vm.dialog = "";
        vm = await snapshot(vm);
        vm.notice = t("Richtlinie gespeichert.");
      } else if (kind === "execute") {
        if (data.confirmed !== true)
          throw Error(t("Neustart muss bestätigt werden."));
        const run =
          id === "__all__"
            ? await coreClient.createRun(
                {
                  all: true,
                  reason: String(data.reason || ""),
                  confirmed: true,
                },
                crypto.randomUUID(),
              )
            : null;
        if (!run)
          await coreClient.createJob(
            {
              containerId: id,
              reason: String(data.reason || ""),
              confirmed: true,
            },
            crypto.randomUUID(),
          );
        vm.dialog = "";
        vm = await snapshot(vm);
        vm.notice = run
          ? t(
              "Sofortlauf gestartet: {v0} Updates, {v1} übersprungen. Fortschritt unter Updates.",
              { v0: run.jobs.length, v1: run.skipped.length },
            )
          : t(
              "Update-Job angelegt. Freigaben und Fortschritt findest du unter Updates.",
            );
      } else if (kind === "approveJob" || kind === "cancelJob") {
        await api(
          "/api/v1/update-jobs/" +
            encodeURIComponent(id) +
            "/" +
            (kind === "approveJob" ? "approve" : "cancel"),
          "POST",
          data,
        );
        vm.dialog = "";
        vm = await snapshot(vm);
        vm.notice = t("Job aktualisiert.");
      } else if (kind === "saveUser") {
        await api("/auth/users", "POST", data);
        vm.dialog = "";
        vm = await snapshot(vm);
        vm.notice = t("Benutzer angelegt.");
      } else if (kind === "revokeUser") {
        await api("/auth/users/revoke", "POST", { id });
        vm = await snapshot(vm);
        vm.notice = t("Sitzungen widerrufen.");
      } else if (kind === "discover") {
        vm = await snapshot(vm, true);
        vm.dialog = "";
        vm.notice = t("Docker-Inventar aktualisiert.");
      } else throw Error(t("Unbekannte Aktion"));
    }
  } catch (e) {
    vm.notice = e instanceof Error ? e.message : t("Aktion fehlgeschlagen");
    vm.error = true;
    if (vm.auth === "loading") vm.auth = "login";
  }
  if (vm.notice) vm.notice = t(vm.notice);
  if (vm.notice)
    vm.toasts = [
      ...vm.toasts,
      {
        id: "cuo-toast-" + crypto.randomUUID(),
        message: vm.notice,
        type: vm.error ? "error" : "success",
        duration: vm.error ? 9000 : 5000,
      },
    ].slice(-4);
  return { vm: present(vm) };
}
export default defineAppServices({
  "cuo.intent": service<Intent, { vm: VM }>({
    kind: "command",
    target: "local",
    concurrency: "serial",
    invoke: intent,
  }),
  "cuo.core": service<Request, unknown>({ kind: "query", target: "server" }),
});
