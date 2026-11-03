import type { VM } from "./contracts.ts";
import { hasUpdate } from "../components/update-candidates.mjs";
export type Notification = {
  id: string;
  title: string;
  message: string;
  page: string;
  tone: string;
};
export function notifications(vm: VM): Notification[] {
  if (vm.user.profile?.updateNotifications === false) return [];
  const dismissed = new Set(vm.dismissed);
  const candidates: Notification[] = vm.containers
    .filter(hasUpdate)
    .map((c) => ({
      id: `update:${c.id}:${c.candidate!.targetDigest}`,
      title: "Update verfügbar",
      message: `${c.name}: Ein neues Image steht bereit.`,
      page: "updates",
      tone: "update",
    }));
  for (const job of vm.jobs.slice(-100)) {
    const state = String(job.state),
      names = ((job.containerIds as string[]) || []).length;
    if (
      [
        "succeeded",
        "failed",
        "intervention_required",
        "pending_approval",
      ].includes(state)
    )
      candidates.push({
        id: `job:${job.id}:${state}`,
        title:
          state === "succeeded"
            ? "Update-Lauf abgeschlossen"
            : state === "pending_approval"
              ? "Freigabe erforderlich"
              : "Update-Lauf benötigt Aufmerksamkeit",
        message: `Lauf ${String(job.id).slice(0, 8)}${names ? ` · ${names} Container` : ""}`,
        page: state === "succeeded" ? "history" : "updates",
        tone: state === "succeeded" ? "success" : "attention",
      });
  }
  return candidates
    .filter((n) => !dismissed.has(n.id))
    .slice(-200)
    .reverse();
}
