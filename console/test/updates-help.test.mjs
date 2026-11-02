import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { executableCandidates } from "../components/update-candidates.mjs";

test("bulk selection excludes stale, unmanaged, excluded, stopped and already active candidates", () => {
  const eligible = {
    id: "one",
    managed: true,
    state: "running",
    mode: "automatic",
    imageId: "old",
    candidate: { targetDigest: "new", sourceDigest: "old" },
  };
  const rows = [
    eligible,
    ...[
      { id: "unmanaged", managed: false },
      { id: "excluded", excluded: true },
      { id: "stopped", state: "exited" },
      { id: "scan", mode: "scan-only" },
      { id: "active" },
      {
        id: "stale",
        candidate: { targetDigest: "new", sourceDigest: "other" },
      },
      {
        id: "error",
        candidate: {
          targetDigest: "new",
          sourceDigest: "old",
          error: "failed",
        },
      },
    ].map((overrides) => ({ ...eligible, ...overrides })),
  ];
  assert.deepEqual(
    executableCandidates({
      containers: rows,
      jobs: [{ containerId: "active", state: "verifying" }],
    }),
    [eligible],
  );
});

test("login rendering hides local credentials only in OIDC-only mode; tutorial renders full local notices as text", async () => {
  const { JSDOM } = await import("../.framework/node_modules/jsdom/lib/api.js");
  const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
  for (const name of [
    "window",
    "document",
    "HTMLElement",
    "customElements",
    "CustomEvent",
    "AbortController",
    "MutationObserver",
  ])
    globalThis[name] = dom.window[name];
  globalThis.fetch = async () => ({ ok: false });
  await import("../components/dialogs.mjs");
  const auth = document.createElement("x-cuo-auth");
  auth.vm = {
    auth: "login",
    oidc: { enabled: true, localLoginEnabled: false },
  };
  assert.equal(
    auth.shadowRoot.querySelectorAll(
      'input[name="name"],input[name="password"],form',
    ).length,
    0,
  );
  assert.ok(auth.shadowRoot.querySelector('[data-kind="oidcLogin"]'));
  auth.vm = {
    auth: "enroll",
    oidc: { enabled: true, localLoginEnabled: false },
  };
  assert.ok(auth.shadowRoot.querySelector('form[data-form="enroll"]'));
  auth.vm = { auth: "login", oidc: { enabled: false } };
  assert.ok(auth.shadowRoot.querySelector('form[data-form="login"]'));
  const { tutorial } = await import("../components/help.mjs");
  const notices = JSON.parse(
    fs.readFileSync(
      new URL("../assets/third-party-notices.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(
    notices.libraries.some((item) => item.name.includes("XTend Maraca")),
  );
  assert.ok(
    notices.libraries.some((item) => item.name === "modernc.org/sqlite"),
  );
  assert.ok(notices.libraries.every((item) => item.text.length > 100));
  const { patch } = await import("../components/base.mjs");
  const host = document.createElement("div");
  patch(
    host,
    tutorial({ ...notices, notice: "<img src=x onerror=alert(1)>" }, "ready"),
  );
  assert.equal(host.querySelectorAll(".tutorial-steps section").length, 8);
  assert.equal(host.querySelectorAll("img,script").length, 0);
  assert.match(host.textContent, /<img src=x/);
  assert.equal(
    host.querySelector(".third-party-notices").getAttribute("tabindex"),
    "0",
  );
  dom.window.close();
});
