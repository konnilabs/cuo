import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTableSort,
  tableSort,
  sortRows,
  timestamp,
  duration,
} from "../components/table-sorting.mjs";

test("sort commands toggle direction, isolate table state and reset container pagination", () => {
  const original = {
    sort: "name",
    sortDirection: "asc",
    offset: 8,
    historySort: "createdAt",
    historySortDirection: "desc",
  };
  const descending = applyTableSort(original, "containers", "name");
  assert.equal(descending.sortDirection, "desc");
  assert.equal(descending.offset, 0);
  assert.equal(original.offset, 8);
  const changed = applyTableSort(descending, "containers", "currentVersion");
  assert.equal(changed.sortDirection, "asc");
  assert.equal(changed.historySortDirection, "desc");
  const history = applyTableSort(original, "history", "createdAt");
  assert.equal(history.historySortDirection, "asc");
  assert.equal(history.sortDirection, "asc");
  assert.equal(history.offset, 8);
  for (const [table, key] of [
    ["containers", "invalid"],
    ["other", "name"],
    ["__proto__", "name"],
  ])
    assert.equal(applyTableSort(original, table, key), original);
});

test("natural column sorting preserves stable ties and does not mutate source records", () => {
  const rows = [
    { id: "ten", value: "1.10" },
    { id: "nine-a", value: "1.9" },
    { id: "nine-b", value: "1.9" },
  ];
  const columns = [{ key: "version", value: (row) => row.value }];
  assert.deepEqual(
    sortRows(rows, { key: "version", direction: "asc" }, columns).map(
      (r) => r.id,
    ),
    ["nine-a", "nine-b", "ten"],
  );
  assert.deepEqual(
    sortRows(rows, { key: "version", direction: "desc" }, columns).map(
      (r) => r.id,
    ),
    ["ten", "nine-a", "nine-b"],
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["ten", "nine-a", "nine-b"],
  );
});

test("missing values stay last in both sort directions", () => {
  const rows = [
    { value: undefined },
    { value: 2 },
    { value: NaN },
    { value: 10 },
  ];
  const columns = [{ key: "number", value: (r) => r.value, numeric: true }];
  assert.deepEqual(
    sortRows(rows, { key: "number", direction: "asc" }, columns).map(
      (r) => r.value,
    ),
    [2, 10, undefined, NaN],
  );
  assert.deepEqual(
    sortRows(rows, { key: "number", direction: "desc" }, columns).map(
      (r) => r.value,
    ),
    [10, 2, undefined, NaN],
  );
});

test("history dates and duration values sort by time rather than formatted strings", () => {
  assert.ok(timestamp("31.10.2026 03:00") < timestamp("01.11.2026 03:00"));
  assert.ok(
    timestamp("2026-10-31T03:00:00Z") < timestamp("2026-11-01T03:00:00Z"),
  );
  assert.equal(timestamp("not a date"), undefined);
  assert.equal(duration({ duration: "1 h 2 min" }), 3720000);
  assert.equal(duration({ duration: "2,5 min" }), 150000);
  assert.equal(
    duration({
      createdAt: "2026-11-01T03:00:00Z",
      updatedAt: "2026-11-01T03:02:00Z",
    }),
    120000,
  );
  assert.equal(duration({}), undefined);
  assert.deepEqual(tableSort({}, "history"), {
    key: "createdAt",
    direction: "desc",
  });
});

test("real table headers dispatch scoped commands and reflect accessible ordering after pagination", async () => {
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
  let vm = {
    containers: Array.from({ length: 12 }, (_, i) => {
      const n = 12 - i;
      return {
        id: "c" + n,
        name: "web-" + n,
        image: "example/app:1." + n,
        group: "Test",
        state: "running",
        mode: "automatic",
        candidate: { targetDigest: "1." + (n + 1) },
        updateTone: n === 12 ? "critical" : "positive",
      };
    }),
    sort: "currentVersion",
    sortDirection: "asc",
    filter: "all",
    query: "",
    offset: 8,
    theme: "light",
    jobs: [
      {
        id: "old",
        createdAt: "31.10.2026 03:00",
        duration: "12 min",
        count: "10",
        state: "succeeded",
      },
      {
        id: "new",
        createdAt: "01.11.2026 03:00",
        duration: "2 min",
        count: "2",
        state: "failed",
      },
    ],
  };
  const table = document.createElement("x-container-table");
  const history = document.createElement("x-update-run-timeline");
  document.body.append(table, history);
  const update = () => {
    table.vm = vm;
    history.vm = vm;
  };
  const commands = [];
  document.body.addEventListener("xtend-command", (event) => {
    commands.push(event.detail);
    if (event.detail.kind === "sort") {
      vm = applyTableSort(vm, event.detail.id, event.detail.value);
      update();
    }
  });
  update();
  const names = () =>
    [...table.shadowRoot.querySelectorAll(".name-link strong")].map(
      (n) => n.textContent,
    );
  assert.equal(names()[0], "web-9");
  assert.equal(
    table.shadowRoot.querySelector("tbody tr .available").className,
    "available positive",
  );
  assert.equal(table.shadowRoot.querySelectorAll("thead .sort").length, 6);
  assert.equal(
    table.shadowRoot.querySelectorAll("thead th[aria-sort]").length,
    1,
  );
  table.shadowRoot
    .querySelector('[data-kind="sort"][data-value="name"]')
    .click();
  assert.equal(commands.at(-1).id, "containers");
  assert.equal(vm.offset, 0);
  assert.deepEqual(names().slice(0, 3), ["web-1", "web-2", "web-3"]);
  const header = table.shadowRoot.querySelector(
    '[data-kind="sort"][data-value="name"]',
  );
  header.focus();
  header.click();
  assert.equal(header.isConnected, true);
  assert.equal(table.shadowRoot.activeElement, header);
  assert.equal(header.parentElement.getAttribute("aria-sort"), "descending");
  assert.equal(
    header.querySelector("x-icon").getAttribute("name"),
    "chevron-down",
  );
  assert.equal(names()[0], "web-12");
  assert.equal(
    table.shadowRoot.querySelector("tbody tr .available").className,
    "available critical",
  );
  assert.equal(history.shadowRoot.querySelector("tbody tr")._key, "new");
  history.shadowRoot
    .querySelector('[data-kind="sort"][data-value="duration"]')
    .click();
  assert.equal(commands.at(-1).id, "history");
  assert.equal(vm.sort, "name");
  assert.equal(vm.sortDirection, "desc");
  history.shadowRoot
    .querySelector('[data-kind="sort"][data-value="duration"]')
    .click();
  assert.equal(history.shadowRoot.querySelector("tbody tr")._key, "old");
  assert.equal(vm.containers[0].name, "web-12");
  table.remove();
  history.remove();
  dom.window.close();
});
