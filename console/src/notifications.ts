import { t } from "../i18n/index.mjs";
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
      title: t("Update verfügbar"),
      message: t("{v0}: Ein neues Image steht bereit.", { v0: c.name }),
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
            ? t("Update-Lauf abgeschlossen")
            : state === "pending_approval"
              ? t("Freigabe erforderlich")
              : t("Update-Lauf benötigt Aufmerksamkeit"),
        message: t("Lauf {v0}{v1}", {
          v0: String(job.id).slice(0, 8),
          v1: names ? ` · ${names} Container` : "",
        }),
        page: state === "succeeded" ? "history" : "updates",
        tone: state === "succeeded" ? "success" : "attention",
      });
  }
  return candidates
    .filter((n) => !dismissed.has(n.id))
    .slice(-200)
    .reverse();
}
