import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
if (Number(process.versions.node.split(".")[0]) < 24)
  throw Error("Node 24.18+ required");
const archive = "../third_party/xtend-49166cb.tar.gz";
if (
  crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex") !==
  "dfee7d8f8efeac0235e507ffc25772150ca6f9de30f5716d714101341f4d74dd"
)
  throw Error("XTend archive hash mismatch");
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (r.status !== 0) process.exit(r.status || 1);
}
if (!fs.existsSync(".framework/package.json")) {
  fs.mkdirSync(".framework", { recursive: true });
  run("tar", ["-xzf", archive, "-C", ".framework"]);
}
run(
  "npm",
  [
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--workspace=@ccslabs/xtend-cli",
    "--workspace=@ccslabs/xtend-maraca",
    "--workspace=@ccslabs/xtend-rmt",
    "--workspace=@ccslabs/xtend-compiler",
    "--include-workspace-root",
  ],
  { cwd: ".framework" },
);
if (!fs.existsSync(".framework/node_modules/@ccslabs/xtend"))
  fs.symlinkSync("../..", ".framework/node_modules/@ccslabs/xtend");
if (!fs.existsSync("node_modules"))
  fs.symlinkSync(".framework/node_modules", "node_modules");
