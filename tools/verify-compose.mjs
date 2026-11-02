// Read the actual embedded Go build info, not just a version label or sidecar.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { composeLock } from "./compose-dependency.mjs";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const lock = composeLock(),
  run = (command, args, options = {}) =>
    execFileSync(command, args, { encoding: "utf8", ...options }).trim();
const imageId = run("docker", [
  "image",
  "inspect",
  "--format",
  "{{.Id}}",
  "cuo-agent:0.2.0",
]);
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
const docker = (...args) =>
  run("docker", [
    "run",
    "--rm",
    "--pull",
    "never",
    "--network",
    "none",
    "--entrypoint",
    ...args.slice(0, 1),
    imageId,
    ...args.slice(1),
  ]);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-compose-verify-"));
try {
  const binary = path.join(directory, "docker-compose"),
    descriptor = fs.openSync(binary, "wx", 0o600);
  try {
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--entrypoint",
        "cat",
        imageId,
        "/usr/local/libexec/docker/cli-plugins/docker-compose",
      ],
      { stdio: ["ignore", descriptor, "pipe"] },
    );
  } finally {
    fs.closeSync(descriptor);
  }
  const info = run("go", ["version", "-m", binary]);
  assert.match(info, /\tpath\tgithub\.com\/docker\/compose\/v5\/cmd\n/);
  assert.ok(info.split("\n")[0].endsWith(" " + lock.COMPOSE_GO_VERSION));
  // Keep upstream's symbol table: stripping it makes binary SCA less precise.
  const symbols = run("go", ["tool", "nm", binary], {
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.match(symbols, /github\.com\/docker\/compose\/v5\/cmd\/compose\./);
  const modules = {};
  for (const module of ["net", "crypto", "text"]) {
    const version = /\tdep\tgolang\.org\/x\/MODULE\t(v\S+)/.source.replace(
      "MODULE",
      module,
    );
    modules["golang.org/x/" + module] = new RegExp(version).exec(info)?.[1];
  }
  assert.deepEqual(modules, {
    "golang.org/x/net": "v0.60.0",
    "golang.org/x/crypto": "v0.57.0",
    "golang.org/x/text": "v0.42.0",
  });
  const version = docker("docker", "compose", "version", "--short");
  assert.equal(
    version.replace(/^v/, ""),
    lock.COMPOSE_VERSION.replace(/^v/, ""),
  );
  const embedded = docker(
    "cat",
    "/usr/share/licenses/cuo/compose/compose.lock",
  );
  assert.equal(
    embedded,
    fs.readFileSync("dependencies/compose/compose.lock", "utf8").trim(),
  );
  const binarySha256 = createHash("sha256")
    .update(fs.readFileSync(binary))
    .digest("hex");
  assert.equal(
    docker("cat", "/usr/share/licenses/cuo/compose/binary.sha256").split(
      /\s/,
    )[0],
    binarySha256,
  );
  fs.mkdirSync("reports", { recursive: true });
  const scanPath = "reports/compose-govulncheck.txt";
  const scanFile = fs.openSync(scanPath, "w", 0o600);
  let scan;
  try {
    scan = spawnSync(
      "go",
      [
        "run",
        "golang.org/x/vuln/cmd/govulncheck@v1.9.0",
        "-mode=binary",
        binary,
      ],
      { stdio: ["ignore", scanFile, scanFile], timeout: 180000 },
    );
  } finally {
    fs.closeSync(scanFile);
  }
  const report = {
    schema: "cuo.compose-backport.v1",
    scope:
      "Actual binary identity, dependency versions, retained symbol information and Go binary vulnerability scan",
    verifiedAt: new Date().toISOString(),
    revision: run("git", ["rev-parse", "HEAD"]),
    dirty: !!run("git", ["status", "--porcelain"]),
    imageId,
    version,
    toolchain: lock.COMPOSE_GO_VERSION,
    binarySha256,
    lock,
    modules,
    passed: scan.status === 0 && !scan.error,
    binarySCA: {
      tool: "govulncheck v1.9.0",
      passed: scan.status === 0 && !scan.error,
      report: scanPath,
    },
    checks: [
      "Actual executable build info",
      "Custom plugin version",
      "Embedded dependency lock matches source",
      "Binary SHA-256 matches shipped record",
      "Symbol information retained for binary SCA",
      "govulncheck -mode=binary passes; module-only advisories remain visible",
    ],
  };
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(
    "reports/compose-backport.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed)
    throw Error("Compose binary vulnerability scan failed; see " + scanPath);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
