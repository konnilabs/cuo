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
  const page = path.split("?")[0].replace(/^\//, "") || "dashboard";
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
  return (
    vm.user.profile || {
      displayName: vm.user.name,
      avatar: "initials",
      theme: vm.themeMode,
      updateNotifications: true,
    }
  );
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
  return theme(vm, String(data.theme));
}
function observePreferences() {
  const boundary = window.XTendMaraca.getSurfaceBoundary();
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
}
// Resource handles only; all application, navigation and filter state lives in RMT.
let stream: EventSource | undefined,
  refreshTimer: ReturnType<typeof setTimeout> | undefined;
function model() {
  return (window.XTendMaraca.model?.getState("cuo.vm") as VM) || initial();
}
async function api(path: string, method = "GET", body?: unknown, key?: string) {
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
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok)
    throw Error(data.message || data.error || "Anfrage fehlgeschlagen");
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
  if (session.user) theme(vm, session.user.profile?.theme || "system");
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
  const data = await Promise.all(paths.map((p) => api("/api/v1/" + p)));
  const [containers, jobs, policies, windows, hosts, events] = data;
  let users = vm.users;
  if (["Owner", "Administrator"].includes(vm.user.role))
    users = (await api("/auth/users")).items;
  return present({
    ...vm,
    containers: containers.items || [],
    jobs: jobs.items || [],
    policies: policies.items || [],
    windows: windows.items || [],
    hosts: hosts.items || [],
    events: (events.items || []).slice(-200),
    users,
  });
}
function connect() {
  if (stream || model().demo) return;
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
    if (kind === "boot") {
      observePreferences();
      vm.page = currentPage();
      if (new URL(location.href).searchParams.get("demo") === "1") {
        vm = demoVM();
        vm.page = currentPage();
        try {
          const data = JSON.parse(
            localStorage.getItem("cuo.demo.profile") || "null",
          );
          if (data)
            vm.user = { ...vm.user, name: data.displayName, profile: data };
        } catch {}
        return { vm: present(theme(vm, vm.user.profile?.theme || "light")) };
      }
      vm = await snapshot(vm, true);
      if (new URL(location.href).searchParams.get("login_error") === "oidc") {
        vm.notice =
          "SSO-Anmeldung fehlgeschlagen oder abgelaufen. Bitte erneut versuchen oder lokal anmelden.";
        vm.error = true;
      }
      if (vm.auth === "ready") connect();
    } else if (kind === "refresh") {
      if (!vm.demo) {
        vm = await snapshot(vm);
        if (vm.auth === "ready") connect();
      }
    } else if (kind === "navigate") {
      if (!Object.hasOwn(pageNames, value)) throw Error("Unbekannte Ansicht");
      const router = document.getElementById(
        "cuo-router",
      ) as XRouterElement | null;
      if (!router?.navigate("/" + value))
        throw Error("Navigation ist noch nicht bereit");
      vm.page = value;
      vm.mobile = false;
      vm.dialog = "";
      vm.notificationsOpen = false;
    } else if (kind === "route") {
      vm.page = routePage(value);
      vm.mobile = false;
      vm.dialog = "";
      vm.notificationsOpen = false;
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
      vm.notice = "Profil gespeichert.";
    } else if (kind === "oidcLogin") {
      location.assign("/auth/oidc/start");
    } else if (kind === "menu") vm.mobile = !vm.mobile;
    else if (kind === "filter") {
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
          "Design-Demo: Änderungen sind deaktiviert. Zur Live-Ansicht wechseln.",
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
        };
        vm.notice = "OIDC-Konfiguration gespeichert und Discovery geprüft.";
      } else if (kind === "scan") {
        await coreClient.scan(crypto.randomUUID());
        vm.notice = "Update-Prüfung gestartet. Ergebnisse erscheinen live.";
        connect();
      } else if (kind === "saveWindow") {
        await api("/api/v1/maintenance-windows", "POST", data);
        vm.dialog = "";
        vm = await snapshot(vm);
        vm.notice = "Wartungsfenster angelegt.";
      } else if (kind === "savePolicy") {
        await api("/api/v1/policies/" + encodeURIComponent(id), "PUT", data);
        vm.dialog = "";
        vm = await snapshot(vm);
        vm.notice = "Richtlinie gespeichert.";
      } else if (kind === "execute") {
        if (data.confirmed !== true)
          throw Error("Neustart muss bestätigt werden.");
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
        vm.notice =
          "Update-Job angelegt. Freigaben und Fortschritt findest du unter Updates.";
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
        vm.notice = "Job aktualisiert.";
      } else if (kind === "saveUser") {
        await api("/auth/users", "POST", data);
        vm.dialog = "";
        vm = await snapshot(vm);
        vm.notice = "Benutzer angelegt.";
      } else if (kind === "revokeUser") {
        await api("/auth/users/revoke", "POST", { id });
        vm = await snapshot(vm);
        vm.notice = "Sitzungen widerrufen.";
      } else if (kind === "discover") {
        vm = await snapshot(vm, true);
        vm.dialog = "";
        vm.notice = "Docker-Inventar aktualisiert.";
      } else throw Error("Unbekannte Aktion");
    }
  } catch (e) {
    vm.notice = e instanceof Error ? e.message : "Aktion fehlgeschlagen";
    vm.error = true;
    if (vm.auth === "loading") vm.auth = "login";
  }
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
