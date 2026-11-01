import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { composeLock, composeDirectory } from "../compose-dependency.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("Compose dependency pins a release and changes only module metadata", () => {
  const lock = composeLock(),
    patch = fs.readFileSync(composeDirectory + "/security.patch", "utf8");
  assert.equal(hash(patch), lock.COMPOSE_PATCH_SHA256);
  assert.deepEqual(
    [...patch.matchAll(/^\+\+\+ b\/(.*)$/gm)].map((m) => m[1]),
    ["go.mod", "go.sum"],
  );
  for (const [module, version] of Object.entries({
    crypto: "0.57.0",
    net: "0.60.0",
    text: "0.42.0",
  }))
    assert.ok(
      patch.includes(`+\tgolang.org/x/${module} v${version} // indirect`),
    );
});
test("prepare validates bytes, exact patch result and existing destinations", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-compose-lock-"));
  try {
    const dependency = path.join(temporary, "dependency"),
      source = path.join(temporary, "source"),
      archive = path.join(temporary, "source.tar.gz"),
      target = path.join(temporary, "target");
    fs.mkdirSync(dependency);
    fs.mkdirSync(path.join(source, "compose-fixture"), { recursive: true });
    fs.copyFileSync(
      composeDirectory + "/prepare.sh",
      dependency + "/prepare.sh",
    );
    fs.writeFileSync(source + "/compose-fixture/go.mod", "old\n");
    fs.writeFileSync(source + "/compose-fixture/go.sum", "sums\n");
    const patch = "--- a/go.mod\n+++ b/go.mod\n@@ -1 +1 @@\n-old\n+patched\n";
    fs.writeFileSync(dependency + "/security.patch", patch);
    execFileSync("tar", ["-czf", archive, "-C", source, "compose-fixture"]);
    const lock = {
      COMPOSE_SOURCE_SHA256: hash(fs.readFileSync(archive)),
      COMPOSE_PATCH_SHA256: hash(patch),
      COMPOSE_MOD_SHA256: hash("patched\n"),
      COMPOSE_SUM_SHA256: hash("sums\n"),
    };
    const writeLock = () =>
      fs.writeFileSync(
        dependency + "/compose.lock",
        Object.entries(lock)
          .map(([key, value]) => key + "=" + value)
          .join("\n") + "\n",
      );
    writeLock();
    const prepare = () =>
      spawnSync("sh", [dependency + "/prepare.sh", archive, target], {
        encoding: "utf8",
      });
    assert.equal(prepare().status, 0);
    assert.equal(fs.readFileSync(target + "/go.mod", "utf8"), "patched\n");
    assert.notEqual(prepare().status, 0);
    assert.equal(fs.readFileSync(target + "/go.mod", "utf8"), "patched\n");
    fs.rmSync(target, { recursive: true });
    fs.appendFileSync(dependency + "/security.patch", "tampered");
    assert.notEqual(prepare().status, 0);
    assert.equal(fs.existsSync(target), false);
    fs.writeFileSync(dependency + "/security.patch", patch);
    lock.COMPOSE_MOD_SHA256 = "0".repeat(64);
    writeLock();
    assert.notEqual(prepare().status, 0);
    fs.rmSync(target, { recursive: true });
    fs.appendFileSync(archive, "tampered");
    assert.notEqual(prepare().status, 0);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
