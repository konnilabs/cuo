import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
fs.mkdirSync("reports", { recursive: true });
function run(args, report) {
  const r = spawnSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (report) fs.writeFileSync("reports/" + report, r.stdout || "");
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    process.stderr.write((r.stdout || "").slice(-16000));
    process.exit(r.status || 1);
  }
  return r.stdout;
}
run(["tools/prepare-xtend.mjs"]);
run(["tools/build-brands.mjs"]);
run(["tools/author-rmt.mjs"]);
run(["tools/audit-source.mjs"]);
run([".framework/node_modules/typescript/bin/tsc", "--noEmit"]);
const cli = ".framework/xtend-builder/bin/xt";
run([cli, "rmt", "lint", "src/app.rmt", "--json"], "rmt-lint.json");
run(
  [cli, "maraca", "plan", "--config", "maraca.config.json", "--json"],
  "maraca-plan.json",
);
run(
  [cli, "maraca", "build", "--config", "maraca.config.json", "--json"],
  "maraca-build.json",
);
run(["tools/harden-runtime.mjs"]);
fs.cpSync("assets", "dist/assets", { recursive: true });
function publicModes(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = directory + "/" + entry.name;
    if (entry.isDirectory()) {
      fs.chmodSync(file, 0o755);
      publicModes(file);
    } else fs.chmodSync(file, 0o644);
  }
}
publicModes("dist/assets");
fs.writeFileSync(
  "dist/boot.mjs",
  `import {bootXtendMaraca} from './xtend.maraca.mjs';\nawait bootXtendMaraca({root:document.getElementById('xtend-maraca-root'),lazyStrategy:'eager',actionHistoryLimit:10,commandHistoryLimit:10,stateProjectionWriteHistoryLimit:0,stateProjectionReadHistoryLimit:20,diagnosticLimit:100});\nawait window.XTendMaraca.dispatchCommand('cuo.intent',{kind:'boot'});\n`,
);
let html = fs
  .readFileSync("dist/index.html", "utf8")
  .replace('lang="en"', 'lang="de"')
  .replace(
    '<meta charset="utf-8">',
    '<meta charset="utf-8"><link rel="icon" href="/assets/favicon.svg">',
  )
  .replace(
    "<title>cuo.app</title>",
    "<title>CUO · Container Update Orchestrator</title>",
  )
  .replace('src="./xtend.maraca.mjs"', 'src="./boot.mjs"');
fs.writeFileSync("dist/index.html", html);
console.log(
  "CUO: TypeScript, source gate, RMT lint and strict Maraca build passed.",
);
