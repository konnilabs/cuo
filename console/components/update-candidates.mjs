import { t } from "../i18n/index.mjs";
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
      hasUpdate(container) &&
      ["automatic", "approval-required"].includes(container.mode) &&
      !active.has(container.id),
  );
}

// Registry results describe an image snapshot, not a container's current state.
// Never reuse them after a reference/config/platform change.
export function currentCandidate(container) {
  const candidate = container.candidate;
  return candidate &&
    container.imageId &&
    candidate.sourceDigest === container.imageId &&
    (!candidate.image || candidate.image === container.image) &&
    (!candidate.platform || candidate.platform === container.platform)
    ? candidate
    : null;
}
export function hasUpdate(container) {
  const candidate = currentCandidate(container);
  return Boolean(
    container.managed &&
    !container.excluded &&
    container.mode !== "disabled" &&
    container.state === "running" &&
    candidate?.targetDigest &&
    candidate.targetDigest !== container.imageId &&
    !candidate.error,
  );
}
export function isCurrent(container) {
  const candidate = currentCandidate(container);
  return Boolean(
    container.managed &&
    !container.excluded &&
    container.state === "running" &&
    candidate &&
    !candidate.targetDigest &&
    !candidate.error,
  );
}
export function containerStatus(container) {
  if (
    container.reason ===
    t("Aufbewahrter Vorgänger für manuelle Wiederherstellung")
  )
    return [t("Aufbewahrter Vorgänger"), "muted"];
  if (container.excluded || !container.managed)
    return [t("Ausgeschlossen"), "muted"];
  const inactive = {
    created: t("Nicht gestartet"),
    exited: t("Gestoppt"),
    paused: t("Pausiert"),
    restarting: t("Neustart läuft"),
    removing: t("Wird entfernt"),
    dead: t("Fehlerhafter Zustand"),
  };
  if (container.state !== "running")
    return [inactive[container.state] || t("Nicht aktiv"), "muted"];
  const candidate = currentCandidate(container);
  return candidate?.error
    ? [t("Prüfung fehlgeschlagen"), "warning"]
    : hasUpdate(container)
      ? [t("Update verfügbar"), "warning"]
      : isCurrent(container)
        ? [t("Aktuell"), "good"]
        : [t("Noch nicht geprüft"), "muted"];
}
