import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const composeDirectory = fileURLToPath(
  new URL("../dependencies/compose/", import.meta.url),
);
export function composeLock(directory = composeDirectory) {
  const values = {};
  for (const line of fs
    .readFileSync(directory + "/compose.lock", "utf8")
    .split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([a-zA-Z0-9.+-]+)$/.exec(line);
    if (!match || values[match[1]])
      throw Error("Invalid or duplicate Compose lock assignment");
    values[match[1]] = match[2];
  }
  for (const key of ["COMPOSE_REVISION", "COMPOSE_SECURITY_REVISION"]) {
    if (!/^[a-f0-9]{40}$/.test(values[key] || ""))
      throw Error("Missing immutable Compose revision");
  }
  for (const key of [
    "COMPOSE_SOURCE_SHA256",
    "COMPOSE_PATCH_SHA256",
    "COMPOSE_MOD_SHA256",
    "COMPOSE_SUM_SHA256",
  ]) {
    if (!/^[a-f0-9]{64}$/.test(values[key] || ""))
      throw Error("Missing Compose content checksum");
  }
  if (!/^v\d+\.\d+\.\d+-cuo\.\d+$/.test(values.COMPOSE_VERSION || ""))
    throw Error("Custom Compose version must be identifiable");
  if (!/^v\d+\.\d+\.\d+$/.test(values.COMPOSE_UPSTREAM_VERSION || ""))
    throw Error("Missing Compose baseline version");
  if (!/^go1\.\d+\.\d+$/.test(values.COMPOSE_GO_VERSION || ""))
    throw Error("Missing exact Compose Go toolchain version");
  return values;
}
