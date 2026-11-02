// Local release evidence only. This command never logs in, pushes or signs.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function summarize(report, expectedID) {
  if (
    report.Metadata?.ImageID !== expectedID ||
    !report.Metadata?.OS?.Family ||
    !Array.isArray(report.Results) ||
    !report.Results.some((r) => r.Class === "os-pkgs")
  ) {
    throw Error("Image identity or OS package scan evidence is missing");
  }
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const result of report.Results) {
    for (const item of result.Vulnerabilities || []) {
      if (!(item.Severity in counts))
        throw Error("Unknown vulnerability severity");
      counts[item.Severity]++;
    }
  }
  return { counts, passed: counts.CRITICAL === 0 && counts.HIGH === 0 };
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}
async function digest(file) {
  const hash = createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return "sha256:" + hash.digest("hex");
}

async function main() {
  process.chdir(fileURLToPath(new URL("..", import.meta.url)));
  const output = path.resolve(
    process.env.CUO_IMAGE_REPORTS || "work/image-checks",
  );
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(output).length)
    throw Error("Use a new empty evidence directory");
  const manifest = {
    schema: "cuo.image-checks.v1",
    createdAt: new Date().toISOString(),
    revision: run("git", ["rev-parse", "HEAD"]),
    dirty: !!run("git", ["status", "--porcelain"]),
    platform: run("docker", [
      "info",
      "--format",
      "{{.OSType}}/{{.Architecture}}",
    ]),
    tools: {
      trivy: run("trivy", ["--version"]),
      syft: run("syft", ["version"]),
    },
    services: [],
    passed: false,
  };
  // Resolve all mutable tags once. Both scanners consume these exact saved bytes.
  const images = ["core", "agent", "console"].map((service) => ({
    service,
    id: run("docker", [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      `cuo-${service}:0.2.0`,
    ]),
  }));
  const zot=JSON.parse(fs.readFileSync("dependencies/zot/zot.lock.json","utf8"));
  images.push({service:"zot",id:run("docker",["image","inspect","--format","{{.Id}}",zot.image])});
  let failed = false;
  for (const { service, id } of images) {
    const archive = path.join(output, `${service}.tar`),
      scan = path.join(output, `${service}-vulnerabilities.json`),
      sbom = path.join(output, `${service}-sbom.cdx.json`);
    if (!/^sha256:[a-f0-9]{64}$/.test(id))
      throw Error("Invalid Docker image identity");
    run("docker", ["image", "save", "--output", archive, id]);
    const entry = {
      service,
      imageId: id,
      archiveSha256: await digest(archive),
      passed: false,
    };
    try {
      run("trivy", [
        "image",
        "--scanners",
        "vuln",
        "--input",
        archive,
        "--format",
        "json",
        "--output",
        scan,
        "--exit-code",
        "0",
        "--timeout",
        "10m",
        "--quiet",
      ]);
      Object.assign(
        entry,
        summarize(JSON.parse(fs.readFileSync(scan, "utf8")), id),
      );
      run("syft", [
        `docker-archive:${archive}`,
        "-o",
        `cyclonedx-json=${sbom}`,
        "--quiet",
      ]);
      const bom = JSON.parse(fs.readFileSync(sbom, "utf8"));
      if (bom.bomFormat !== "CycloneDX" || !bom.components?.length)
        throw Error("Empty/invalid image SBOM");
      entry.sbomComponents = bom.components.length;
      entry.scanSha256 = await digest(scan);
      entry.sbomSha256 = await digest(sbom);
      entry.archiveRetained = process.env.CUO_KEEP_IMAGE_ARCHIVES === "1";
    } catch (error) {
      entry.passed = false;
      entry.error =
        "Scanner or evidence validation failed; inspect local command output";
      console.error(`${service}: ${error.message}`);
    } finally {
      if (!entry.archiveRetained) fs.rmSync(archive, { force: true });
    }
    failed ||= !entry.passed;
    manifest.services.push(entry);
    fs.writeFileSync(
      path.join(output, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  }
  manifest.passed = !failed;
  manifest.completedAt = new Date().toISOString();
  // Capture the DB metadata after scanning, including a first-run DB download.
  manifest.tools.trivy = run("trivy", ["--version"]);
  fs.writeFileSync(
    path.join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(JSON.stringify(manifest, null, 2));
  if (failed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
