import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  validateDependency,
  verifyArchive,
  resolveFramework,
} from "../tools/resolve-framework.mjs";
const lock = JSON.parse(
  fs.readFileSync(new URL("../xtend.lock.json", import.meta.url), "utf8"),
);
test("XTend dependency requires an immutable revision and approved HTTPS source", () => {
  validateDependency(lock);
  for (const update of [
    { revision: "main" },
    { source: { ...lock.source, url: "http://example.invalid/framework.tgz" } },
    { workspaces: ["../../untrusted"] },
    { source: { ...lock.source, sha256: "not-a-hash" } },
  ])
    assert.throws(() => validateDependency({ ...lock, ...update }));
});
test("source archive integrity is checked before use", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-dependency-"));
  try {
    const file = path.join(dir, "archive");
    fs.writeFileSync(file, "downloaded bytes");
    const pin = {
      source: {
        sha256: crypto
          .createHash("sha256")
          .update("downloaded bytes")
          .digest("hex"),
      },
    };
    verifyArchive(file, pin);
    fs.appendFileSync(file, "tampered");
    assert.throws(() => verifyArchive(file, pin), /integrity/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("an invalid cached dependency does not replace the existing checkout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-dependency-"));
  try {
    fs.writeFileSync(path.join(dir, "xtend.lock.json"), JSON.stringify(lock));
    fs.mkdirSync(path.join(dir, ".cache"));
    fs.writeFileSync(
      path.join(dir, ".cache", `xtend-${lock.revision}.tar.gz`),
      "corrupted",
    );
    fs.mkdirSync(path.join(dir, ".framework"));
    fs.writeFileSync(path.join(dir, ".framework", "sentinel"), "keep");
    await assert.rejects(resolveFramework(dir), /integrity/);
    assert.equal(
      fs.readFileSync(path.join(dir, ".framework", "sentinel"), "utf8"),
      "keep",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
