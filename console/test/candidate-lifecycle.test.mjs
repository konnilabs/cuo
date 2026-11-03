import test from "node:test";
import assert from "node:assert/strict";
import {
  hasUpdate,
  isCurrent,
  currentCandidate,
  containerStatus,
  executableCandidates,
} from "../components/update-candidates.mjs";
import { initial, present } from "../src/view.ts";
const workload = (overrides = {}) => ({
  id: "app",
  name: "app",
  image: "example/app:stable",
  imageId: "sha256:old",
  platform: "linux/amd64",
  managed: true,
  excluded: false,
  mode: "automatic",
  state: "running",
  candidate: {
    sourceDigest: "sha256:old",
    targetDigest: "sha256:new",
    image: "example/app:stable",
    platform: "linux/amd64",
  },
  ...overrides,
});

test("image observations are bound to config, reference and platform; stale errors are hidden too", () => {
  for (const overrides of [
    { imageId: "sha256:updated" },
    { image: "example/app:held" },
    { platform: "linux/arm64" },
  ]) {
    const row = workload(overrides);
    assert.equal(currentCandidate(row), null);
    assert.equal(hasUpdate(row), false);
    assert.equal(isCurrent(row), false);
    assert.equal(containerStatus(row)[0], "Noch nicht geprüft");
    row.candidate.error = "obsolete error";
    assert.equal(containerStatus(row)[0], "Noch nicht geprüft");
  }
});

test("runtime state and retained predecessors stay distinct from actionable updates", () => {
  for (const [state, label] of [
    ["created", "Nicht gestartet"],
    ["exited", "Gestoppt"],
    ["paused", "Pausiert"],
    ["restarting", "Neustart läuft"],
  ]) {
    const row = workload({ state });
    assert.equal(hasUpdate(row), false);
    assert.equal(isCurrent(row), false);
    assert.equal(containerStatus(row)[0], label);
    assert.deepEqual(executableCandidates({ containers: [row] }), []);
  }
  const backup = workload({
    managed: false,
    excluded: true,
    state: "exited",
    reason: "Aufbewahrter Vorgänger für manuelle Wiederherstellung",
  });
  assert.equal(containerStatus(backup)[0], "Aufbewahrter Vorgänger");
  assert.equal(hasUpdate(backup), false);
  assert.equal(hasUpdate(workload()), true);
  assert.equal(
    isCurrent(
      workload({ candidate: { sourceDigest: "sha256:old", targetDigest: "" } }),
    ),
    true,
  );
});

test("dashboard and notifications count the same current, running managed workloads", () => {
  const rows = [
    workload(),
    workload({ id: "created", state: "created" }),
    workload({ id: "stopped", state: "exited" }),
    workload({ id: "backup", managed: false, excluded: true }),
    workload({ id: "stale", imageId: "sha256:updated" }),
    workload({
      id: "current",
      candidate: { sourceDigest: "sha256:old", targetDigest: "" },
    }),
  ];
  const vm = present({ ...initial(), containers: rows });
  assert.equal(vm.updateCount, "1");
  assert.equal(vm.currentCount, "1");
  assert.deepEqual(
    vm.notifications.filter((n) => n.tone === "update").map((n) => n.id),
    ["update:app:sha256:new"],
  );
});

test("real custom table filters, badges and available versions agree after replacement and stopping", async () => {
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
  ])
    globalThis[key] = dom.window[key];
  globalThis.fetch = async () => ({ ok: false });
  await import("../components/widgets.mjs");
  const table = document.createElement("x-container-table");
  document.body.append(table);
  const active = workload(),
    stopped = workload({ id: "stopped", name: "stopped", state: "exited" });
  table.vm = {
    containers: [active, stopped],
    filter: "all",
    query: "",
    jobs: [],
  };
  assert.equal(table.shadowRoot.querySelectorAll(".available").length, 1);
  const stoppedBadge = table.shadowRoot.querySelectorAll(
    "x-update-status-badge",
  )[1];
  assert.match(stoppedBadge.shadowRoot.textContent, /Gestoppt/);
  table.vm = {
    containers: [active, stopped],
    filter: "updates",
    query: "",
    jobs: [],
  };
  assert.equal(table.shadowRoot.querySelectorAll("tbody .name-link").length, 1);
  active.imageId = "sha256:new";
  table.vm = {
    containers: [active, stopped],
    filter: "updates",
    query: "",
    jobs: [],
  };
  assert.equal(table.shadowRoot.querySelectorAll("tbody .name-link").length, 0);
  table.remove();
  dom.window.close();
});
