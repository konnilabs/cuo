import fs from "node:fs";
import { pageNames as initialPages, initial, present } from "../src/view.ts";
const el = (tag, attrs = {}, children = [], extra = {}) => ({
  type: "element",
  tag,
  ...(attrs.class ? { class: attrs.class } : {}),
  attributes: Object.fromEntries(
    Object.entries(attrs).filter(([k]) => k !== "class"),
  ),
  children,
  ...extra,
});
const text = (tag, content, cls = "") =>
  el(tag, { class: cls }, [], { text: content });
const ic = (name, pack = "core", size = "20") =>
  el("x-icon", { name, pack, size: size + "px", decorative: true });
const cmd = (label, kind, value = "", symbol, cls = "btn", pack = "core") =>
  el(
    "button",
    {
      type: "button",
      class: cls + " cuo-action",
      "data-id": "",
      "aria-label": label || kind,
      "data-kind": kind,
      "data-value": value,
    },
    [...(symbol ? [ic(symbol, pack)] : []), text("span", label)],
  );
const widget = (tag, attrs = {}) =>
  el(
    tag,
    {
      class: "cuo-widget",
      "data-cuo-widget": "true",
      "data-view": "$model.cuo.vm.serialized",
      ...attrs,
    },
    [],
  );
const links = [
  ["dashboard", "Dashboard", "home", "core"],
  ["containers", "Container", "cube", "cuo"],
  ["updates", "Updates", "refresh", "core"],
  ["schedule", "Zeitplanung", "calendar", "cuo"],
  ["policies", "Richtlinien", "shield", "core"],
  ["history", "Historie", "history", "cuo"],
  ["logs", "Logs", "docs", "core"],
  ["settings", "Einstellungen", "settings", "core"],
];
const nav = ([page, label, name, pack]) =>
  el(
    "button",
    {
      type: "button",
      "data-id": "",
      class: "$model.cuo.vm.nav" + page,
      "data-kind": "navigate",
      "data-value": page,
    },
    [
      ic(name, pack),
      text("span", label),
      ...(page === "updates"
        ? [text("span", "$model.cuo.vm.updateCount", "nav-badge")]
        : []),
    ],
  );
const sidebar = el(
  "aside",
  { class: "sidebar", "aria-label": "Hauptnavigation" },
  [
    el(
      "a",
      {
        class: "brand cuo-action",
        "data-id": "",
        href: "#",
        "aria-label": "CUO Dashboard",
        "data-kind": "navigate",
        "data-value": "dashboard",
      },
      [
        el("span", { class: "brand-cube" }, [ic("logo", "cuo", "44")]),
        el("div", {}, [
          el("div", { class: "brand-name" }, [
            text("strong", "CUO"),
            text("small", "v0.1.0"),
          ]),
          text("p", "Container Update Orchestrator"),
        ]),
      ],
    ),
    el("nav", { class: "nav-main" }, links.map(nav)),
    el("div", { class: "system-nav" }, [
      text("p", "SYSTEM", "nav-label"),
      ...[
        ["hosts", "Hosts", "server", "lucide"],
        ["users", "Benutzer", "users", "cuo"],
        ["integrations", "Integrationen", "link", "cuo"],
      ].map(nav),
    ]),
    el("div", { class: "core-status" }, [
      widget("x-host-health", { compact: true }),
    ]),
  ],
);
const topbar = el("header", { class: "topbar" }, [
  cmd("Menü", "menu", "", "menu", "icon-btn mobile-toggle"),
  el("label", { class: "global-search" }, [
    ic("search"),
    el(
      "input",
      {
        type: "search",
        class: "cuo-query",
        accesskey: "k",
        "aria-keyshortcuts": "Alt+K",
        placeholder: "Container, Images, Tags oder Events suchen ...",
        "aria-label": "Globale Suche",
        maxlength: 160,
        "data-global-search": "true",
        "data-kind-input": "query",
      },
      [],
      { props: { value: "$model.cuo.vm.query" } },
    ),
    text("kbd", "Alt K"),
  ]),
  el("div", { class: "topbar-tools" }, [
    cmd(
      "$model.cuo.vm.themeToggleLabel",
      "theme",
      "",
      "$model.cuo.vm.themeToggleIcon",
      "icon-btn",
    ),
    el(
      "button",
      {
        type: "button",
        class: "icon-btn notification cuo-action",
        "data-id": "",
        "aria-label": "Benachrichtigungen",
        id: "cuo-notifications-trigger",
        "aria-controls": "cuo-notification-center",
        "aria-expanded": "$model.cuo.vm.notificationsExpanded",
        "data-kind": "notifications",
        "data-value": "",
      },
      [
        ic("bell", "cuo"),
        text(
          "span",
          "$model.cuo.vm.notificationCount",
          "$model.cuo.vm.notificationClass",
        ),
      ],
    ),
    el(
      "button",
      {
        type: "button",
        class: "user-menu cuo-action",
        "aria-label": "Dein Profil öffnen",
        "aria-haspopup": "dialog",
        "aria-expanded": "$model.cuo.vm.profileExpanded",
        "data-id": "",
        "data-kind": "profile",
        "data-value": "",
      },
      [
        el("span", { class: "avatar" }, [
          text(
            "span",
            "$model.cuo.vm.userInitials",
            "$model.cuo.vm.avatarTextClass",
          ),
          el("x-icon", {
            name: "$model.cuo.vm.avatarName",
            pack: "$model.cuo.vm.avatarPack",
            size: "20px",
            class: "$model.cuo.vm.avatarIconClass",
            decorative: true,
          }),
        ]),
        el("span", { class: "user-info" }, [
          text("strong", "$model.cuo.vm.user.name"),
          text("small", "$model.cuo.vm.user.role"),
        ]),
        ic("chevron-down"),
      ],
    ),
    widget("x-cuo-notifications", { id: "cuo-notification-center" }),
  ]),
]);
const stat = (symbol, pack, cls, children) =>
  el("section", { class: "stat-card" }, [
    el("div", { class: "stat-icon " + cls }, [ic(symbol, pack, "32")]),
    el("div", { class: "stat-content" }, children),
  ]);
const stats = el("div", { class: "stats" }, [
  stat("cube", "cuo", "blue", [
    text("strong", "$model.cuo.vm.total", "stat-number"),
    text("p", "Container"),
    el("small", {}, [
      text("span", "$model.cuo.vm.monitored"),
      text("span", " überwacht · "),
      text("span", "$model.cuo.vm.excludedCount"),
      text("span", " ausgeschlossen"),
    ]),
  ]),
  stat("refresh", "core", "green", [
    text("strong", "$model.cuo.vm.updateCount", "stat-number"),
    text("p", "Updates verfügbar"),
    text("small", "$model.cuo.vm.updateHint"),
  ]),
  stat("calendar", "cuo", "violet", [
    text("small", "Nächster Update-Lauf", "stat-label"),
    text("strong", "$model.cuo.vm.nextDate", "stat-date"),
    text("p", "$model.cuo.vm.nextTime"),
  ]),
  stat("shield-check", "lucide", "green", [
    text("small", "Systemstatus", "stat-label"),
    text("strong", "$model.cuo.vm.systemTitle", "stat-date"),
    text("p", "$model.cuo.vm.systemDetail"),
  ]),
]);
const quick = [
  ["Jetzt nach Updates suchen", "scan", "", "search", "core"],
  ["Update-Lauf starten", "run", "", "play", "core"],
  ["Neues Wartungsfenster erstellen", "window", "", "calendar", "cuo"],
  ["Container ausschließen", "navigate", "containers", "ban", "cuo"],
  ["Protokolle anzeigen", "navigate", "logs", "docs", "core"],
  ["Einstellungen öffnen", "navigate", "settings", "settings", "core"],
];
const dashboard = el("div", { class: "$model.cuo.vm.dashboardClass" }, [
  el("section", { class: "card container-panel" }, [
    widget("x-container-table"),
  ]),
  el("section", { class: "card calendar-panel" }, [
    widget("x-maintenance-planner"),
  ]),
  el("section", { class: "card history-panel" }, [
    widget("x-update-run-timeline", { compact: true }),
  ]),
  el("section", { class: "card activity-panel" }, [widget("x-log-stream")]),
  el("section", { class: "card quick-panel" }, [
    text("h2", "Schnellaktionen"),
    el(
      "div",
      { class: "quick-actions" },
      quick.map(([label, kind, value, symbol, pack]) =>
        cmd(label, kind, value, symbol, "quick-action", pack),
      ),
    ),
  ]),
]);
const routed = [
  ["containers", [widget("x-container-table")]],
  ["updates", [widget("x-update-run-timeline"), widget("x-container-table")]],
  [
    "schedule",
    [
      el("div", { class: "panel-heading" }, [
        text("h2", "Wartungsfenster"),
        cmd("Neues Fenster", "window", "", "plus", "btn primary", "cuo"),
      ]),
      widget("x-maintenance-planner"),
    ],
  ],
  ["policies", [widget("x-policy-editor")]],
  ["history", [widget("x-update-run-timeline")]],
  ["logs", [widget("x-log-stream", { expanded: true })]],
  ["hosts", [widget("x-host-health")]],
  ["users", [widget("x-cuo-workspace", { section: "users" })]],
  ["settings", [widget("x-cuo-workspace", { section: "settings" })]],
  ["integrations", [widget("x-cuo-workspace", { section: "integrations" })]],
].map(([page, children]) =>
  el(
    "section",
    { class: "$model.cuo.vm.route" + page, "aria-label": page },
    children,
  ),
);
const shell = el(
  "div",
  { class: "$model.cuo.vm.shellClass", "data-theme": "$model.cuo.vm.theme" },
  [
    el(
      "x-router",
      {
        id: "cuo-router",
        class: "cuo-router",
        mode: "hash",
        "navigation-policy": "spa",
        "reuse-component": true,
        "data-kind": "route",
        "data-id": "",
      },
      Object.keys(initialPages)
        .map((page) =>
          el(
            "x-route",
            {
              path: "/" + page,
              component: "x-cuo-route",
              title: initialPages[page],
            },
            [],
          ),
        )
        .concat([
          el(
            "x-route",
            { path: "/", component: "x-cuo-route", title: "Dashboard" },
            [],
          ),
        ]),
    ),
    sidebar,
    el("div", { class: "main-shell" }, [
      topbar,
      el(
        "main",
        {
          class: "$model.cuo.vm.mainContentClass",
          id: "main-content",
          tabindex: "-1",
        },
        [
          el("div", { class: "$model.cuo.vm.demoClass" }, [
            text(
              "span",
              "Design-Demo · Beispieldaten · Aktionen ohne Docker-Ausführung",
            ),
            cmd(
              "Live-Ansicht öffnen",
              "exitDemo",
              "",
              "arrow-right",
              "text-btn",
              "lucide",
            ),
          ]),
          el("div", { class: "page-heading" }, [
            el("div", {}, [
              text("h1", "$model.cuo.vm.title"),
              text("p", "$model.cuo.vm.description"),
            ]),
            el("div", { class: "heading-actions" }, [
              cmd("Jetzt prüfen", "scan", "", "search", "btn"),
              cmd("Update-Lauf starten", "run", "", "play", "btn"),
              cmd(
                "Container hinzufügen",
                "add",
                "",
                "plus",
                "btn primary",
                "cuo",
              ),
            ]),
          ]),
          stats,
          dashboard,
          el("div", { class: "$model.cuo.vm.workspaceClass" }, routed),
        ],
      ),
    ]),
    widget("x-approval-dialog"),
    widget("x-cuo-profile"),
  ],
);
const tree = {
  id: "cuo-shell",
  layoutEngine: "document-flow",
  viewTemplate: {
    class: "cuo-root",
    children: [
      el("a", { href: "#main-content", class: "skip-link" }, [], {
        text: "Zum Inhalt springen",
      }),
      el("div", { class: "$model.cuo.vm.authClass" }, [widget("x-cuo-auth")]),
      shell,
      widget("x-cuo-toasts", {
        id: "cuo-toast-layer",
        popover: "manual",
        "data-toast-layer": true,
        role: "region",
        "aria-label": "Statusmeldungen",
      }),
    ],
  },
};
function rmt(v, indent = 0) {
  if (v === null) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  const pad = " ".repeat(indent);
  if (Array.isArray(v))
    return (
      "[\n" +
      v.map((x) => pad + "  " + rmt(x, indent + 2)).join("\n") +
      "\n" +
      pad +
      "]"
    );
  return (
    "{\n" +
    Object.entries(v)
      .map(
        ([k, v]) =>
          pad +
          "  " +
          (/^[A-Za-z_][\w.-]*$/.test(k) ? k : JSON.stringify(k)) +
          " " +
          rmt(v, indent + 2),
      )
      .join("\n") +
    "\n" +
    pad +
    "}"
  );
}
const vm = present(initial());
for (const page of Object.keys(vm)
  .filter((k) => k.startsWith("nav"))
  .map((k) => k.slice(3)))
  vm["route" + page] = "is-hidden";
const source = `// CUO shell. Authoring source: tools/author-rmt.mjs. Runtime ownership: RMT only.
template cuo.app {
 state cuo.vm type object preserve { initial ${rmt(vm, 2)} }
 state cuo.shell type object preserve { initial ${rmt(tree, 2)} }
 selector cuo.shell from state cuo.shell { output CUOShell }
 datasource cuo.intent from host cuo.intent { mode invoke
  contract "cuo.intent.v1" }
 datasource cuo.core from host cuo.core { mode invoke
  contract "cuo.core.v1" }
 action cuo.intent {
  input kind string { trust boundary "xtend.security.sanitizing-boundary.v1"
   sanitize text }
  input value string optional
  input id string optional
  input data object optional
  effect fetch datasource cuo.intent
  reduce state.cuo.vm = result.vm
 }
 resource cuo.events kind stream owner surface.cuo.shell { dispose on surface.destroy }
 portal cuo.root root "#xtend-maraca-root" layer surface
 surface cuo.shell kind region component section {
  source selector cuo.shell
  key shell.id
  portal cuo.root
  lane visible weight 100 { hydrate cuo-shell from selector cuo.shell }
  destroy releases resource cuo.events
  on click ".cuo-action" -> action cuo.intent {
   preventDefault true
   payload kind from source.dataset.kind
   payload value from source.dataset.value
   payload id from source.dataset.id
  }
  on route-changed ".cuo-router" -> action cuo.intent {
   payload kind from source.dataset.kind
   payload value from detail.path
   payload id from source.dataset.id
  }
  on input ".cuo-query" -> action cuo.intent {
   payload kind from source.dataset.kindInput
   payload value from source.value
  }
  on xtend-command ".cuo-widget" -> action cuo.intent {
   payload kind from detail.kind
   payload value from detail.value
   payload id from detail.id
   payload data from detail.data
  }
 }
}
`;
fs.writeFileSync("src/app.rmt", source);
fs.writeFileSync(
  "components/manifest.json",
  JSON.stringify(
    {
      "x-icon": "../.framework/components/xicon.js",
      "x-router": "../vendor/xrouter.mjs",
      "x-route": "../vendor/xrouter.mjs",
      "x-toggle": "../.framework/components/xtoggle.js",
      "x-drawer": "../vendor/xdrawer.mjs",
      "x-toast": "../.framework/components/xtoast.js",
      "x-cuo-toasts": "./toasts.mjs",
      "x-cuo-notifications": "./account.mjs",
      "x-cuo-profile": "./account.mjs",
      ...Object.fromEntries(
        [
          "x-container-table",
          "x-maintenance-planner",
          "x-update-run-timeline",
          "x-log-stream",
          "x-policy-editor",
          "x-host-health",
          "x-update-status-badge",
        ].map((tag) => [tag, "./widgets.mjs"]),
      ),
      ...Object.fromEntries(
        ["x-cuo-auth", "x-approval-dialog", "x-cuo-workspace"].map((tag) => [
          tag,
          "./dialogs.mjs",
        ]),
      ),
    },
    null,
    2,
  ) + "\n",
);
