import { t } from "../i18n/index.mjs";
import { h, field } from "./base.mjs";

export const hostPermissionKeys = ["preserveSysAdmin", "preserveSysPtrace", "preserveDacReadSearch", "preserveHostPid"];
export const permissionKeys = ["readOnlyHostMonitoring", ...hostPermissionKeys];
const elevated = (permissions = {}) => hostPermissionKeys.some((key) => permissions[key]);
const bool = (value) => value === "on" || value === "true";

export function permissionEditor(vm, selected, can) {
  const host = can(vm, "execution.host-preservation.grant");
  const shared = host || (can(vm, "execution.monitoring.grant") && !elevated(selected.permissions));
  const options = [
    ["readOnlyHostMonitoring", t("Bestehende lesende Host-Mounts für Monitoring zulassen"), shared && can(vm, "execution.monitoring.grant")],
    ["preserveSysAdmin", t("SYS_ADMIN beim Update beibehalten"), host],
    ["preserveSysPtrace", t("SYS_PTRACE beim Update beibehalten"), host],
    ["preserveDacReadSearch", t("DAC_READ_SEARCH beim Update beibehalten"), host],
    ["preserveHostPid", t("Host-PID-Zugriff beim Update beibehalten"), host],
  ];
  return h("fieldset", { class: "execution-permissions" },
    h("legend", {}, t("Erweiterte Ausführungsfreigaben")),
    h("p", { class: "callout small", role: "note" }, t("Achtung: Monitoring-Mounts geben dem Container Einblick in Host-Prozesse und Systeminformationen. Die Freigabe gilt dauerhaft für Updates dieses Containers, einschließlich automatischer Läufe. Nur für vertrauenswürdige Images aktivieren. Volumes und Anwendungsdaten werden bei einem Fehler nicht automatisch zurückgesetzt.")),
    h("p", { class: "callout warning small" }, t("SYS_ADMIN und Host-PID gewähren weitreichenden Zugriff auf den Host. Nur ein Owner darf diese Freigaben vergeben oder widerrufen. CUO erhält ausschließlich bereits vorhandene Rechte; die Auswahl fügt dem Container keine neuen Rechte hinzu.")),
    h("div", { class: "permission-options" }, options.map(([name, label, writable]) =>
      h("label", { class: "checkbox" }, h("input", { type: "checkbox", name, checked: !!selected.permissions?.[name], disabled: !writable }), label))),
    h("p", { class: "muted small" }, t("Nur für eine konkrete Container-Richtlinie. Nicht freigegebene Capabilities, privilegierter Modus, Geräte sowie Host-Netzwerk und Host-IPC bleiben gesperrt. Schreibende System-Mounts und direkte Docker-Sockets sind nicht enthalten.")),
    field(t("Freigabegrund"), "permissionReason", selected.permissionReason || "", "text", { maxlength: 500, disabled: !shared }),
    h("label", { class: "checkbox" }, h("input", { type: "checkbox", name: "permissionsConfirmed", disabled: !shared }), t("Ich habe die Auswirkungen geprüft und bestätige den Host-Zugriff.")));
}

export function collectPermissions(form, vm, previous, can) {
  const f = new FormData(form);
  const before = previous?.permissions || {};
  const host = can(vm, "execution.host-preservation.grant");
  const shared = host || (can(vm, "execution.monitoring.grant") && !elevated(before));
  const permissions = { ...before };
  for (const key of permissionKeys) {
    const writable = key === "readOnlyHostMonitoring" ? shared && can(vm, "execution.monitoring.grant") : host;
    if (writable && (key === "readOnlyHostMonitoring" || bool(f.get(key)) || Object.hasOwn(before, key))) permissions[key] = bool(f.get(key));
  }
  const enabled = permissionKeys.some((key) => permissions[key]);
  const confirmation = form.elements.namedItem("permissionsConfirmed");
  const reason = form.elements.namedItem("permissionReason");
  for (const name of ["scope", "target", "permissionsConfirmed", "permissionReason"]) form.elements.namedItem(name)?.setCustomValidity("");
  if (enabled && (f.get("scope") !== "container" || !/^[a-f0-9]{64}$/.test(String(f.get("target"))))) {
    form.elements.namedItem("target").setCustomValidity(t("Ausführungsfreigaben benötigen eine konkrete Container-Richtlinie mit gültiger Ziel-ID."));
    form.reportValidity(); return null;
  }
  if (!shared) return { permissions, permissionReason: previous?.permissionReason || "", permissionsConfirmed: previous?.permissionsConfirmed || false };
  if (enabled && !bool(f.get("permissionsConfirmed"))) {
    confirmation.setCustomValidity(t("Bestätige zuerst den Warnhinweis zum Host-Zugriff.")); confirmation.reportValidity(); return null;
  }
  if (enabled && String(f.get("permissionReason") || "").trim().length < 3) {
    reason.setCustomValidity(t("Bitte gib einen Freigabegrund mit mindestens drei Zeichen an.")); reason.reportValidity(); return null;
  }
  return { permissions, permissionReason: enabled ? String(f.get("permissionReason")).trim() : "", permissionsConfirmed: enabled && bool(f.get("permissionsConfirmed")) };
}
