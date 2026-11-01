import fs from "node:fs";
import crypto from "node:crypto";
// Disable three unused legacy HTML paths from the pinned XTend runtime. CUO only
// accepts DOM descriptors. A call to a legacy HTML path fails closed.
const report = [];
for (const name of fs.readdirSync("dist/runtime")) {
  if (!/\.(mjs|js)$/.test(name)) continue;
  const file = "dist/runtime/" + name,
    before = fs.readFileSync(file, "utf8");
  let source = before;
  let count = 0;
  for (const pattern of [
    /doc\.documentElement\.innerHTML\s*=\s*IS_EMPTY_INPUT \? emptyHTML : dirtyPayload;/g,
    /templateElement\.innerHTML\s*=\s*html \|\| '';/g,
  ])
    source = source.replace(pattern, () => {
      count++;
      return "throw new Error('CUO disables legacy HTML materialization; use RMT DOM descriptors.');";
    });
  if (
    /\.(?:innerHTML|outerHTML)\s*=(?!=)|insertAdjacentHTML\s*\(|document\.write\s*\(/.test(
      source,
    )
  )
    throw Error("Unreviewed HTML sink in " + file);
  if (count) {
    fs.writeFileSync(file, source);
    report.push({
      file,
      count,
      before: crypto.createHash("sha256").update(before).digest("hex"),
      after: crypto.createHash("sha256").update(source).digest("hex"),
    });
  }
}
fs.writeFileSync(
  "reports/runtime-hardening.json",
  JSON.stringify(report, null, 2) + "\n",
);
