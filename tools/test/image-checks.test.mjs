import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { summarize } from "../check-images.mjs";

const id = "sha256:" + "a".repeat(64);
const report = (v = []) => ({
  Metadata: { ImageID: id, OS: { Family: "alpine" } },
  Results: [{ Class: "os-pkgs", Vulnerabilities: v }],
});
test("image gate requires matching identity and OS scan coverage", () => {
  assert.equal(summarize(report(), id).passed, true);
  for (const invalid of [
    {},
    { ...report(), Results: [] },
    { ...report(), Metadata: { ImageID: "wrong", OS: { Family: "alpine" } } },
  ])
    assert.throws(() => summarize(invalid, id));
});
test("unfixed high/critical CVEs still fail the release gate", () => {
  for (const Severity of ["HIGH", "CRITICAL"])
    assert.equal(
      summarize(report([{ Severity, Status: "will_not_fix" }]), id).passed,
      false,
    );
  assert.equal(summarize(report([{ Severity: "LOW" }]), id).passed, true);
  assert.throws(() => summarize(report([{ Severity: "invented" }]), id));
});
test("legacy release entrypoint cannot publish", () => {
  const result = spawnSync(
    "sh",
    [new URL("../release.sh", import.meta.url).pathname],
    {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        CUO_REGISTRY: "example.invalid",
        VERSION: "test",
      },
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /publication is disabled/);
});
