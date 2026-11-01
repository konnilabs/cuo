import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
export function validateDependency(lock) {
  if (
    lock.schema !== "cuo.xtend-dependency-lock.v1" ||
    lock.name !== "@ccslabs/xtend" ||
    !/^\d+\.\d+\.\d+$/.test(lock.version) ||
    !/^[a-f0-9]{40}$/.test(lock.revision) ||
    !/^[a-f0-9]{64}$/.test(lock.source?.sha256) ||
    lock.repository !== "https://github.com/konnilabs/xtend" ||
    lock.source.url !==
      `https://codeload.github.com/konnilabs/xtend/tar.gz/${lock.revision}` ||
    !Array.isArray(lock.workspaces) ||
    lock.workspaces.some((name) => !/^@ccslabs\/xtend-[a-z-]+$/.test(name))
  )
    throw Error("Invalid XTend dependency lock");
}
export function verifyArchive(file, lock) {
  const actual = crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
  if (actual !== lock.source.sha256)
    throw Error(
      "XTend archive integrity check failed; remove the invalid cached archive before retrying",
    );
}
export async function resolveFramework(root) {
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, "xtend.lock.json"), "utf8"),
  );
  validateDependency(lock);
  const framework = path.join(root, ".framework"),
    marker = path.join(framework, ".cuo-dependency.json");
  if (
    fs.existsSync(marker) &&
    JSON.stringify(JSON.parse(fs.readFileSync(marker, "utf8"))) ===
      JSON.stringify(lock)
  )
    return lock;
  const cache = path.join(root, ".cache");
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, `xtend-${lock.revision}.tar.gz`);
  if (!fs.existsSync(archive)) {
    const temporary = archive + ".partial-" + process.pid;
    try {
      const response = await fetch(lock.source.url, {
        redirect: "error",
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok || !response.body)
        throw Error(
          "XTend dependency download failed: HTTP " + response.status,
        );
      let size = 0;
      const limit = new Transform({
        transform(chunk, encoding, done) {
          size += chunk.length;
          done(
            size > 100 * 1024 * 1024
              ? Error("XTend dependency exceeds size limit")
              : null,
            chunk,
          );
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        limit,
        fs.createWriteStream(temporary, { flags: "wx" }),
      );
      verifyArchive(temporary, lock);
      fs.renameSync(temporary, archive);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  verifyArchive(archive, lock);
  const temporary = path.join(cache, "framework-" + crypto.randomUUID());
  fs.mkdirSync(temporary);
  try {
    const result = spawnSync(
      "tar",
      ["-xzf", archive, "--strip-components=1", "-C", temporary],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw Error("XTend dependency extraction failed");
    const metadata = JSON.parse(
      fs.readFileSync(path.join(temporary, "package.json"), "utf8"),
    );
    if (metadata.name !== lock.name || metadata.version !== lock.version)
      throw Error("XTend package does not match dependency lock");
    fs.writeFileSync(
      path.join(temporary, ".cuo-dependency.json"),
      JSON.stringify(lock, null, 2) + "\n",
    );
    const existing = fs.lstatSync(framework, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink())
      fs.unlinkSync(framework); // Never delete the linked checkout.
    else if (existing)
      fs.renameSync(
        framework,
        path.join(cache, "previous-framework-" + crypto.randomUUID()),
      );
    fs.renameSync(temporary, framework);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return lock;
}
