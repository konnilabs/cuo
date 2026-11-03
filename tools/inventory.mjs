import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const go = execFileSync(
  "go",
  ["list", "-m", "-f", "{{.Path}}@{{.Version}}", "all"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .map((s) => {
    const [name, version] = s.split("@");
    return { name, version: version || "0.3.0" };
  });
const archives = fs
  .readdirSync("third_party")
  .filter((s) => s.endsWith(".tar.gz"))
  .map((name) => ({
    name,
    sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync("third_party/" + name))
      .digest("hex"),
  }));
const xtend = JSON.parse(fs.readFileSync("console/xtend.lock.json", "utf8"));
const inventory = {
  schema: "cuo.source-dependency-inventory.v1",
  note: "Source inventory; complete OCI/OS SBOM is a separate release gate.",
  version: "0.3.0",
  goToolchain: execFileSync("go", ["version"], { encoding: "utf8" }).trim(),
  goModules: go,
  browser: {
    framework: `XTend ${xtend.version}`,
    commit: xtend.revision,
    dependency: xtend,
    thirdPartyScripts: "bundled local XTend only",
    icons: "XIcon local node-based packs",
    fonts: "Roboto regular and medium",
  },
  server: {
    node: "24.22.1",
    npmRuntimeDependencies: Object.entries(
      JSON.parse(fs.readFileSync("console/runtime/package-lock.json", "utf8"))
        .packages,
    )
      .filter(([name]) => name.startsWith("node_modules/"))
      .map(([name, value]) => ({
        name: name.slice(13),
        version: value.version,
        integrity: value.integrity,
      })),
    maraca: "bundled AppServices host",
  },
  archives,
};
fs.mkdirSync("reports", { recursive: true });
fs.writeFileSync(
  "reports/dependency-inventory.json",
  JSON.stringify(inventory, null, 2) + "\n",
);
