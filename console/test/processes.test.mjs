import test from "node:test";
import assert from "node:assert/strict";
import {
  processInitial,
  loadProcesses,
  processIntent,
  seedDemoProcesses,
} from "../src/processes.ts";
test("RMT process intents retain filters and use authoritative run IDs", async () => {
  let vm = {
    ...processInitial(),
    page: "history",
    capabilities: ["inventory.read"],
    user: { role: "Viewer" },
    jobs: [{ id: "child", runId: "batch" }],
    dialog: "",
    selected: "",
  };
  const calls = [];
  const run = { id: "batch", kind: "run" };
  const api = async (path) => {
    calls.push(path);
    return path.includes("/process-runs/")
      ? { run, events: [], eventCount: 0 }
      : path.includes("/log-retention")
        ? { policy: {} }
        : { items: [run], upcoming: [], total: 1 };
  };
  vm = await processIntent(
    vm,
    {
      kind: "processFilter",
      data: { query: "redis", status: "failed", from: "2026-11-01" },
    },
    api,
  );
  assert.match(calls[0], /q=redis/);
  assert.match(calls[0], /status=failed/);
  assert.equal(vm.processTotal, 1);
  vm = await processIntent(vm, { kind: "processJob", id: "child" }, api);
  assert.equal(vm.selected, "batch");
  assert.equal(vm.dialog, "process");
  assert.equal(vm.processDetail.run.id, "batch");
  vm = await loadProcesses({ ...vm, capabilities: [] }, api);
  assert.deepEqual(vm.processRuns, []);
  assert.equal(vm.processDetail, null);
});
test("demo offers labeled historical records and refuses destructive maintenance", async () => {
  const vm = seedDemoProcesses({
    ...processInitial(),
    demo: true,
    jobs: [{ id: "example", state: "failed", reason: "Beispiel", count: 1 }],
    events: [],
  });
  assert.equal(vm.processTotal, 1);
  assert.equal(vm.processRuns[0].telemetryAvailable, false);
  const detail = await processIntent(
    vm,
    { kind: "processDetails", id: "example" },
    () => {
      throw Error("network forbidden");
    },
  );
  assert.equal(detail.processDetail.run.id, "example");
  await assert.rejects(
    processIntent(vm, { kind: "logMaintenance" }, () => {}),
    /deaktiviert/,
  );
});
test("registered process widgets render safe drilldown, filter and owner-only retention commands", async () => {
  const { JSDOM } = await import("../.framework/node_modules/jsdom/lib/api.js");
  const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
  for (const key of [
    "window",
    "document",
    "HTMLElement",
    "customElements",
    "CustomEvent",
    "AbortController",
    "MutationObserver",
    "FormData",
  ])
    globalThis[key] = dom.window[key];
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  globalThis.fetch = async () => ({ ok: false });
  await import("../components/processes.mjs");
  const base = {
    ...processInitial(),
    theme: "light",
    user: { role: "Owner" },
    capabilities: [],
    jobs: [],
    events: [],
    processRuns: [
      {
        id: "<run>",
        name: "<script>bad()</script>",
        state: "failed",
        containerCount: 1,
        anomalies: [],
      },
    ],
    processTotal: 1,
  };
  const widget = document.createElement("x-cuo-process-manager");
  document.body.append(widget);
  widget.vm = base;
  assert.equal(widget.shadowRoot.querySelector("script"), null);
  assert.match(widget.shadowRoot.textContent, /<script>bad/);
  let intent;
  widget.addEventListener("xtend-command", (e) => (intent = e.detail));
  widget.shadowRoot.querySelector('[data-kind="processDetails"]').click();
  assert.equal(intent.id, "<run>");
  const ret = document.createElement("x-cuo-log-retention");
  document.body.append(ret);
  ret.vm = {
    ...base,
    logStorage: {
      policy: {
        revision: 1,
        enabled: false,
        days: 30,
        maxEvents: 100000,
        intervalHours: 24,
      },
      events: 4,
      databaseBytes: 4096,
      reusableBytes: 0,
      activeJobs: 1,
    },
  };
  assert.ok(ret.shadowRoot.querySelector('form[data-form="logMaintenance"]'));
  ret.vm = { ...ret.vm, user: { role: "Administrator" } };
  assert.equal(ret.shadowRoot.querySelector("form"), null);
  const detail = document.createElement("x-cuo-process-detail");
  document.body.append(detail);
  detail.vm = {
    ...base,
    dialog: "process",
    processDetail: {
      run: {
        ...base.processRuns[0],
        kind: "run",
        anomalies: [
          { code: "historical", message: "Messwerte fehlen", severity: "info" },
        ],
      },
      jobs: [],
      events: [
        {
          id: 1,
          time: "2026-11-03T00:00:00Z",
          message: "<img src=x>",
          stage: "done",
          severity: "info",
        },
      ],
      logsPruned: true,
      eventCount: 1,
    },
  };
  assert.ok(detail.shadowRoot.querySelector("dialog").open);
  assert.match(detail.shadowRoot.textContent, /Messwerte fehlen/);
  assert.equal(detail.shadowRoot.querySelector("img"), null);
  assert.match(detail.shadowRoot.textContent, /wurden gelöscht/);
  dom.window.close();
});
