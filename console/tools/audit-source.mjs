import fs from "node:fs";
import path from "node:path";
const patterns = [
  /\.innerHTML\b/,
  /\.outerHTML\b/,
  /insertAdjacentHTML\s*\(/,
  /document\.write\s*\(/,
  /dangerouslySetInnerHTML/,
  /eval\s*\(/,
  /new Function\s*\(/,
];
let files = [];
for (const dir of ["src", "components"]) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile() && /\.(mjs|ts|rmt)$/.test(file))
      files.push(file);
  }
}
const failures = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const p of patterns) if (p.test(text)) failures.push(file + ": " + p);
  if (
    file.startsWith("src/") &&
    !file.includes("server-services") &&
    /from ['"][^'"]*(?:server\/|node:|docker)/.test(text)
  )
    failures.push(file + ": privileged browser import");
}
if (failures.length) throw Error(failures.join("\n"));
console.log("Source security gate passed: " + files.length + " files.");
