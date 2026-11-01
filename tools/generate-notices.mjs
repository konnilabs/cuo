// Offline application notices from the actual linked Go modules and pinned JS
// runtime. OS packages are inventoried separately by the OCI release process.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const read = (file) => fs.readFileSync(file, "utf8");
const licenseFiles = (directory) =>
  fs
    .readdirSync(directory)
    .filter(
      (name) =>
        /^(licen[cs]e|copying|copyright|notice)(?:[._-]|$)/i.test(name) &&
        fs.statSync(path.join(directory, name)).isFile(),
    )
    .sort();
const licenseText = (directory, all = false) => {
  const names = all
    ? fs.readdirSync(directory).sort()
    : licenseFiles(directory);
  if (!names.length) throw Error("Missing license for " + directory);
  return names
    .map((name) => name + "\n\n" + read(path.join(directory, name)))
    .join("\n\n");
};
const licenseName = (text) =>
  /Apache License/.test(text)
    ? "Apache-2.0"
    : /Permission is hereby granted, free of charge/.test(text)
      ? "MIT"
      : /Redistribution and use in source and binary forms/.test(text)
        ? "BSD · siehe Lizenztext"
        : "Siehe Lizenztext";
const xtend = JSON.parse(read("console/xtend.lock.json"));
const libraries = [
  {
    name: "XTend Maraca / RMT / XIcon",
    version: xtend.version + " · " + xtend.revision.slice(0, 7),
    license: "Apache-2.0",
    source: xtend.repository + "/tree/" + xtend.revision,
    text: read("third_party/XTend-LICENSE"),
  },
  {
    name: "Watchtower – angepasster GetCreateConfig-Code",
    version: "1.7.1 · a047c7f",
    license: "Apache-2.0",
    source:
      "https://github.com/containrrr/watchtower/tree/a047c7f9ff11813f930f6998863fa1b8a015985c",
    text: read("third_party/Watchtower-LICENSE"),
  },
  {
    name: "Roboto",
    version: "Regular / Medium",
    license: "Apache-2.0",
    source: "https://github.com/googlefonts/roboto",
    text: read("console/assets/Roboto-LICENSE.txt"),
  },
];
const runtime = JSON.parse(read("console/runtime/package-lock.json"));
for (const [key, value] of Object.entries(runtime.packages)) {
  if (!key.startsWith("node_modules/")) continue;
  const name = key.slice(13),
    text = licenseText("console/runtime/" + key);
  libraries.push({
    name,
    version: value.version,
    license: licenseName(text),
    source: "https://www.npmjs.com/package/" + name + "/v/" + value.version,
    text,
  });
}
const linked = new Set(
  execFileSync(
    "go",
    ["list", "-deps", "-f", "{{with .Module}}{{.Path}}{{end}}", "./cmd/cuo"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n"),
);
const modules = execFileSync(
  "go",
  ["list", "-m", "-f", "{{.Path}}\t{{.Version}}\t{{.Dir}}\t{{.Main}}", "all"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .map((line) => {
    const [Path, Version, Dir, Main] = line.split("\t");
    return { Path, Version, Dir, Main: Main === "true" };
  });
for (const module of modules) {
  if (module.Main || !linked.has(module.Path)) continue;
  const text = licenseText(module.Dir);
  libraries.push({
    name: module.Path,
    version: module.Version,
    license: licenseName(text),
    source: "https://pkg.go.dev/" + module.Path + "@" + module.Version,
    text,
  });
}
const brands = JSON.parse(read("console/brands/sources.lock.json"));
libraries.push({
  name: "Produkt-Icons · Dashboard Icons / Appsmith",
  version: "Gepinnte Quellstände",
  license: "Apache-2.0 · Markenhinweise beachten",
  source: "https://github.com/homarr-labs/dashboard-icons",
  text:
    licenseText("console/brands/LICENSES", true) +
    "\n\nQuellstände und SHA-256-Werte\n" +
    JSON.stringify(brands, null, 2),
});
const output =
  JSON.stringify(
    {
      schema: "cuo.notices.v1",
      licenseText: read("LICENSE"),
      notice: read("NOTICE"),
      libraries,
    },
    null,
    2,
  ) + "\n";
const file = "console/assets/third-party-notices.json";
if (process.argv.includes("--check")) {
  if (!fs.existsSync(file) || read(file) !== output)
    throw Error(
      "Application notices are stale; run node tools/generate-notices.mjs",
    );
} else fs.writeFileSync(file, output);
console.log(
  `Application notices verified: ${libraries.length} libraries/resources.`,
);
