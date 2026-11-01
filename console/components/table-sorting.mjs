// Sorting belongs to the RMT view model. Widgets sort copies of authorized data;
// no DOM reordering, server mutations or external table runtime are involved.
const columns = {
  containers: [
    "name",
    "image",
    "currentVersion",
    "availableVersion",
    "status",
    "mode",
  ],
  history: ["createdAt", "duration", "affected", "result"],
};
const collator = new Intl.Collator("de", {
  numeric: true,
  sensitivity: "base",
});
export function tableSort(vm, table) {
  return table === "history"
    ? {
        key: vm.historySort || "createdAt",
        direction: vm.historySortDirection === "asc" ? "asc" : "desc",
      }
    : {
        key: vm.sort || "",
        direction: vm.sortDirection === "desc" ? "desc" : "asc",
      };
}
export function applyTableSort(vm, table, key) {
  table ||= "containers";
  if (!Object.hasOwn(columns, table) || !columns[table].includes(key))
    return vm;
  const current = tableSort(vm, table);
  const direction =
    current.key === key
      ? current.direction === "asc"
        ? "desc"
        : "asc"
      : table === "history" && key === "createdAt"
        ? "desc"
        : "asc";
  return table === "history"
    ? { ...vm, historySort: key, historySortDirection: direction }
    : { ...vm, sort: key, sortDirection: direction, offset: 0 };
}
export function sortRows(rows, state, definitions) {
  const column = definitions.find((column) => column.key === state.key);
  if (!column) return [...rows];
  const missing = (value) =>
    value === null ||
    value === undefined ||
    value === "" ||
    (typeof value === "number" && !Number.isFinite(value));
  const factor = state.direction === "desc" ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, value: column.value(row) }))
    .sort((a, b) => {
      // Empty/invalid values remain last in both directions, with stable ties.
      const emptyA = missing(a.value),
        emptyB = missing(b.value);
      if (emptyA || emptyB)
        return emptyA === emptyB ? a.index - b.index : emptyA ? 1 : -1;
      const result = column.numeric
        ? Number(a.value) - Number(b.value)
        : collator.compare(String(a.value), String(b.value));
      return result * factor || a.index - b.index;
    })
    .map(({ row }) => row);
}
export function timestamp(value) {
  if (typeof value !== "string" || !value) return undefined;
  const german = value.match(
    /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  const result = german
    ? new Date(
        Number(german[3]),
        Number(german[2]) - 1,
        Number(german[1]),
        Number(german[4] || 0),
        Number(german[5] || 0),
        Number(german[6] || 0),
      ).getTime()
    : /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)
      ? Date.parse(value)
      : NaN;
  return Number.isFinite(result) ? result : undefined;
}
export function duration(job) {
  if (typeof job.duration === "string") {
    const text = job.duration.trim();
    const units = { ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 };
    const matches = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(ms|min|s|h|d)\b/g)];
    if (
      matches.length &&
      !text.replace(/(\d+(?:[.,]\d+)?)\s*(ms|min|s|h|d)\b/g, "").trim()
    )
      return matches.reduce(
        (sum, match) =>
          sum + Number(match[1].replace(",", ".")) * units[match[2]],
        0,
      );
  }
  const start = timestamp(job.createdAt),
    end = timestamp(job.updatedAt);
  return start !== undefined && end !== undefined
    ? Math.max(0, end - start)
    : undefined;
}
