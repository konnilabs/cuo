import { t } from "../i18n/index.mjs";
import type { VM, Intent } from "./contracts.ts";
import type {
  DataExport,
  ProcessRun,
  ProcessDetail,
  LogStorage,
} from "./generated-api.ts";
type API = (
  path: string,
  method?: string,
  body?: unknown,
  key?: string,
) => Promise<any>;
export function processInitial() {
  return {
    processRuns: [] as ProcessRun[],
    processTotal: 0,
    processUpcoming: [] as ProcessRun[],
    processKind: "run",
    processQuery: "",
    processStatus: "all",
    processFrom: "",
    processTo: "",
    processOffset: 0,
    processDetail: null as ProcessDetail | null,
    logStorage: null as LogStorage | null,
  };
}
function parameters(vm: VM) {
  return new URLSearchParams({
    kind: String(vm.processKind),
    q: String(vm.processQuery),
    status: String(vm.processStatus),
    from: String(vm.processFrom),
    to: String(vm.processTo),
    offset: String(vm.processOffset),
    limit: "50",
  });
}
export async function loadProcesses(vm: VM, api: API): Promise<VM> {
  const can =
    vm.user.role === "Owner" ||
    ((vm.capabilities as string[]) || []).includes("inventory.read");
  if (!can) return { ...vm, ...processInitial() };
  if (vm.page === "history") {
    const data = await api("/api/v1/process-runs?" + parameters(vm));
    vm = {
      ...vm,
      processRuns: data.items,
      processTotal: data.total,
      processUpcoming: data.upcoming,
    };
  }
  if (["history", "logs", "settings"].includes(vm.page))
    vm = { ...vm, logStorage: await api("/api/v1/log-retention") };
  if (vm.dialog === "process" && vm.selected) {
    const detail = await api(
      "/api/v1/process-runs/" + encodeURIComponent(vm.selected),
    );
    const prior = vm.processDetail as ProcessDetail | null;
    if (
      prior &&
      prior.run.id === detail.run.id &&
      prior.events.length > 200 &&
      detail.eventCount >= prior.eventCount &&
      !detail.logsPruned
    ) {
      const events = new Map(
        [...prior.events, ...detail.events].map((e) => [e.id, e]),
      );
      detail.events = [...events.values()].sort((a, b) => a.id - b.id);
      detail.nextEventId = Math.max(prior.nextEventId, detail.nextEventId);
      detail.moreEvents = detail.eventCount > detail.events.length;
    }
    vm = { ...vm, processDetail: detail };
  }
  return vm;
}
export async function processIntent(
  vm: VM,
  input: Intent,
  api: API,
): Promise<VM | null> {
  const { kind, value = "", id = "", data = {} } = input;
  if (kind === "processDetails" || kind === "processJob") {
    const job = kind === "processJob" ? vm.jobs.find((j) => j.id === id) : null;
    vm = {
      ...vm,
      dialog: "process",
      selected: String(job?.runId || job?.id || id),
      processDetail: null,
    };
    if (vm.demo) {
      const run =
        demoProcesses(vm).find((r) => r.id === vm.selected) ||
        vm.processUpcoming.find((r) => r.id === vm.selected);
      vm.processDetail = run
        ? {
            run,
            jobs: [],
            events: [],
            eventCount: 0,
            nextEventId: 0,
            moreEvents: false,
            logsPruned: false,
          }
        : null;
      return vm;
    }
    return loadProcesses(vm, api);
  }
  if (kind === "processKind")
    vm = { ...vm, processKind: value, processOffset: 0 };
  else if (kind === "processPage")
    vm = { ...vm, processOffset: Math.max(0, Number(value) || 0) };
  else if (kind === "processFilter")
    vm = {
      ...vm,
      processQuery: String(data.query || "").slice(0, 160),
      processStatus: String(data.status || "all"),
      processFrom: String(data.from || ""),
      processTo: String(data.to || ""),
      processOffset: 0,
    };
  else if (kind === "processRefresh") {
  } else if (kind === "processMore") {
    if (vm.demo) return vm;
    const prior = vm.processDetail as ProcessDetail;
    if (!prior?.moreEvents) return vm;
    const next = await api(
      "/api/v1/process-runs/" +
        encodeURIComponent(vm.selected) +
        "?after=" +
        prior.nextEventId,
    );
    const seen = new Set(prior.events.map((e) => e.id));
    return {
      ...vm,
      processDetail: {
        ...next,
        events: [
          ...prior.events,
          ...next.events.filter((e: any) => !seen.has(e.id)),
        ],
      },
    };
  } else if (kind === "downloadData" || kind === "exportData") {
    if (vm.demo)
      throw Error(t("Downloads sind in der Live-Ansicht verfügbar."));
    const format =
        kind === "downloadData" ? value : String(data.format || "xlsx"),
      dataset =
        kind === "downloadData" ? id : String(data.dataset || "processes");
    const query = new URLSearchParams({
      dataset,
      format,
      q: String(data.query || ""),
      from: String(data.from || ""),
      to: String(data.to || ""),
      status: String(data.status || "all"),
    });
    if (kind === "downloadData") query.set("runId", vm.selected);
    const file = (await api("/api/v1/exports?" + query)) as DataExport;
    const bytes = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(
      new Blob([bytes], { type: file.contentType }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return {
      ...vm,
      notice: t("{v0} Zeilen als {v1} heruntergeladen.", {
        v0: file.rows,
        v1: format.toUpperCase(),
      }),
    };
  } else if (kind === "saveLogRetention" || kind === "logMaintenance") {
    if (vm.demo)
      throw Error(t("Datenbereinigung ist in der Design-Demo deaktiviert."));
    if (kind === "saveLogRetention")
      await api("/api/v1/log-retention", "PUT", data, crypto.randomUUID());
    else {
      const { action, ...request } = data;
      const result = await api(
        "/api/v1/log-retention/" + String(action),
        "POST",
        request,
        crypto.randomUUID(),
      );
      vm.notice = result.compacted
        ? t("Datenbank komprimiert.")
        : t("{v0} Protokolleinträge gelöscht; {v1} offene Jobs geschützt.", {
            v0: result.deleted,
            v1: result.protectedJobs,
          });
    }
    vm = { ...vm, notice: vm.notice || t("Aufbewahrung gespeichert.") };
    return loadProcesses(vm, api);
  } else return null;
  return vm.demo ? filterDemo(vm) : loadProcesses(vm, api);
}

function demoProcesses(vm: VM): ProcessRun[] {
  return vm.jobs.map((j, i) => ({
    id: String(j.id),
    kind: "run",
    name: "Beispiellauf " + (i + 1),
    state: String(j.state),
    createdAt: `2026-10-${String(26 - i * 7).padStart(2, "0")}T02:00:00Z`,
    startedAt: "",
    finishedAt: "",
    nextStart: "",
    durationMs: 0,
    queueMs: 0,
    baselineMs: 0,
    baselineSamples: 0,
    containerCount: Number(j.count) || 1,
    succeeded: j.state === "succeeded" ? Number(j.count) || 1 : 0,
    failed: j.state === "failed" ? 1 : 0,
    pending: 0,
    jobIds: [String(j.id)],
    containerIds: [],
    anomalies: [
      {
        code: "demo",
        severity: "info",
        message: t("Beispieldaten; keine gemessene Telemetrie."),
      },
    ],
    reason: String(j.reason || ""),
    requester: "Design-Demo",
    windowId: "standard",
    skipped: [],
    telemetryAvailable: false,
  }));
}
export function seedDemoProcesses(vm: VM): VM {
  return filterDemo({
    ...vm,
    processRuns: demoProcesses(vm),
    logStorage: {
      policy: {
        revision: 1,
        enabled: false,
        days: 30,
        maxEvents: 100000,
        intervalHours: 24,
        lastRun: "",
        lastDeleted: 0,
      },
      events: vm.events.length,
      databaseBytes: 0,
      reusableBytes: 0,
      activeJobs: 0,
    },
  });
}
function filterDemo(vm: VM): VM {
  const rows = (
    vm.processKind === "forecast" ? vm.processUpcoming : demoProcesses(vm)
  ).filter(
    (r) =>
      (!vm.processQuery ||
        (r.name + " " + r.id)
          .toLowerCase()
          .includes(vm.processQuery.toLowerCase())) &&
      (vm.processStatus === "all" ||
        vm.processStatus === r.state ||
        vm.processStatus === "completed"),
  );
  return {
    ...vm,
    processRuns: rows.slice(vm.processOffset, vm.processOffset + 50),
    processTotal: rows.length,
  };
}
