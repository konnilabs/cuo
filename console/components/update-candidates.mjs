const terminal = new Set([
  "succeeded",
  "failed",
  "intervention_required",
  "cancelled",
]);
export function executableCandidates(vm) {
  const active = new Set(
    (vm.jobs || [])
      .filter((job) => !terminal.has(job.state))
      .map((job) => job.containerId),
  );
  return (vm.containers || []).filter(
    (container) =>
      container.managed &&
      container.state === "running" &&
      !container.excluded &&
      ["automatic", "approval-required"].includes(container.mode) &&
      container.candidate?.targetDigest &&
      !container.candidate.error &&
      container.candidate.sourceDigest === container.imageId &&
      !active.has(container.id),
  );
}
