import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean),
  bad = [];
for (const file of files) {
  if (/(^|\/)\.env$|\.db(?:-|$)|\.(pem|key)$/.test(file)) bad.push(file);
  if (!/\.(mjs|ts|go|ya?ml|json|md|sh)$/.test(file)) continue;
  const s = fs.readFileSync(file, "utf8");
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{30,}/.test(
      s,
    )
  )
    bad.push(file);
}
if (bad.length) throw Error("Potential secret files: " + bad.join(", "));
console.log(
  "Tracked-file credential pattern check passed: " + files.length + " files.",
);
