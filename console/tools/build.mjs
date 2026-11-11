import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { preparePwaBuild, finishPwaBuild } from "./pwa.mjs";
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
const pwa = preparePwaBuild(process.cwd());
run(
  [cli, "maraca", "plan", "--config", pwa.configFile, "--json"],
  "maraca-plan.json",
);
run(
  [cli, "maraca", "build", "--config", pwa.configFile, "--json"],
  "maraca-build.json",
);
run(["tools/harden-runtime.mjs"]);
fs.cpSync("assets", "dist/assets", { recursive: true });
// Reuse compiler-validated RMT motion records in the custom shell decoration.
// The component does not invent a second set of animation timings/keyframes.
const motion = JSON.parse(fs.readFileSync("reports/maraca-plan.json", "utf8"))
  .orchestration.artifact.animationEngine;
const sidebarAnimations = motion.animations.filter((record) =>
  record.id.startsWith("cuo.sidebar."),
);
if (
  sidebarAnimations.length !== 4 ||
  sidebarAnimations.some(
    (record) =>
      record.reducedMotion !== "instant" || record.keyframes.length !== 2,
  )
)
  throw Error("Missing or unsafe compiled RMT sidebar motion presets");
fs.writeFileSync(
  "dist/assets/sidebar-motion.json",
  JSON.stringify({
    schema: motion.schema,
    animations: sidebarAnimations.map(({ sourceRef, ...record }) => record),
    transitions: [],
  }) + "\n",
);
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
  `import {bootXtendMaraca} from './xtend.maraca.mjs';\nimport {serviceWorkerUrl} from './assets/cuo-pwa-registration.mjs';\nawait bootXtendMaraca({root:document.getElementById('xtend-maraca-root'),serviceWorkerUrl:serviceWorkerUrl(),lazyStrategy:'eager',actionHistoryLimit:10,commandHistoryLimit:10,stateProjectionWriteHistoryLimit:0,stateProjectionReadHistoryLimit:20,diagnosticLimit:100});\nawait window.XTendMaraca.dispatchCommand('cuo.intent',{kind:'boot'});\n`,
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
html = html.replace(
  "</head>",
  '<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png"><meta name="theme-color" content="#10192a"><meta name="apple-mobile-web-app-title" content="CUO"></head>',
);
fs.writeFileSync("dist/index.html", html);
finishPwaBuild(process.cwd(), pwa.fingerprint);
publicModes("dist/icons");
console.log(
  "CUO: TypeScript, source gate, RMT lint and strict Maraca build passed.",
);
