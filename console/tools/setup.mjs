import fs from "node:fs";
import { resolveFramework } from "./resolve-framework.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
if (Number(process.versions.node.split(".")[0]) < 24)
  throw Error("Node 24.18+ required");
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (r.status !== 0) process.exit(r.status || 1);
}
const dependency = await resolveFramework(process.cwd());
run(
  "npm",
  [
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    ...dependency.workspaces.map((name) => "--workspace=" + name),
    "--include-workspace-root",
  ],
  { cwd: ".framework" },
);
if (!fs.existsSync(".framework/node_modules/@ccslabs/xtend"))
  fs.symlinkSync("../..", ".framework/node_modules/@ccslabs/xtend");
if (!fs.existsSync("node_modules"))
  fs.symlinkSync(".framework/node_modules", "node_modules");

run("npm", [
  "ci",
  "--prefix",
  "runtime",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
]);
