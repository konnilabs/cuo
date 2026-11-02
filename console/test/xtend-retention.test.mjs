import test from "node:test";
import assert from "node:assert/strict";
import { createRmtActionEffectRuntime } from "../.framework/xtendrmt/rmt-action-effect-runtime.js";
import { createRmtAppRuntime } from "../.framework/xtendrmt/rmt-app-runtime.js";
import { createRmtStateHostAdapter } from "../.framework/xtendrmt/rmt-state-host-adapter.js";

test("long-lived status commands retain bounded history and current-run diagnostics", async () => {
  const action = createRmtActionEffectRuntime({
    actions: [{ id: "status.refresh" }],
    planningOnly: true,
  });
  const app = createRmtAppRuntime({ actionRuntime: action });
  let first;
  for (let frame = 0; frame < 350; frame++) {
    const result = await app.command("status.refresh", { frame });
    assert.equal(result.status, "success");
    assert.equal(result.result.diagnostics.length, 2);
    first ||= result;
  }
  const recent = app.listCommands();
  assert.equal(recent.length, 100);
  assert.equal(recent[0].result.data.frame, 250);
  assert.equal(recent.at(-1).result.data.frame, 349);
  assert.equal(action.listHistory().length, 100);
  assert.equal(action.listDiagnostics().length, 200);
  assert.equal(app.listDiagnostics().length, 200);
  assert.equal(app.getPerformanceTelemetrySnapshot().commandCount, 350);
  assert.equal(first.result.data.frame, 0);
  assert.equal(first.result.diagnostics.length, 2);
});

test("bounded projection journals preserve all canonical state updates", () => {
  const values = new Map();
  let commits = 0;
  const adapter = createRmtStateHostAdapter({
    strict: true,
    target: {
      batchUpdate(changes) {
        commits++;
        for (const [key, value] of Object.entries(changes)) values.set(key, value);
      },
      get: (key) => values.get(key),
    },
  });
  for (let frame = 0; frame < 350; frame++) {
    adapter.batchUpdate({ "cuo.vm": { frame } });
    assert.equal(adapter.get("cuo.vm").frame, frame);
  }
  assert.equal(commits, 350);
  assert.equal(values.get("cuo.vm").frame, 349);
  assert.equal(adapter.listWrites().length, 100);
  assert.equal(adapter.listReads().length, 100);
  assert.equal(adapter.listWrites()[0].value.frame, 250);
});
