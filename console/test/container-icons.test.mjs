import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  imageRepository,
  resolveContainerIcon,
  brands,
} from "../components/container-icon-catalog.mjs";
import { createBrandLoader } from "../components/brand-loader.mjs";
import { validateBrandPack } from "../components/brand-contract.mjs";
import { buildBrandPack } from "../tools/build-brands.mjs";

test("brand identity uses exact canonical repositories, independent of tags/digests/names", () => {
  for (const image of [
    "redis",
    "redis:7",
    "docker.io/redis:7-alpine",
    "index.docker.io/library/redis",
    "registry-1.docker.io/library/redis:7@sha256:" + "a".repeat(64),
  ]) {
    assert.equal(imageRepository(image), "docker.io/library/redis");
    assert.equal(resolveContainerIcon(image).key, "redis");
  }
  for (const image of [
    "mycorp/redis:7",
    "private.example:5000/library/redis:7",
    "my-redis:7",
    "ghcr.io/somebody/immich-server:latest",
  ])
    assert.equal(resolveContainerIcon(image).key, null);
  for (const image of [
    "https://example.com/redis.svg",
    "redis@sha256:bad",
    "redis@sha256:" + "a".repeat(64) + "@junk",
    "redis:bad tag",
    "../redis",
    "redis/",
    "Redis:7",
    "sha256:" + "a".repeat(64),
  ])
    assert.equal(imageRepository(image), null);
  assert.equal(
    resolveContainerIcon("ghcr.io/immich-app/immich-server:v2").key,
    "immich",
  );
  assert.equal(
    resolveContainerIcon("vaultwarden/server:latest", { theme: "dark" }).icon,
    "vaultwarden-light",
  );
  assert.equal(
    resolveContainerIcon("vaultwarden/server:latest", { theme: "light" }).icon,
    "vaultwarden",
  );
  assert.equal(
    resolveContainerIcon("portainer/portainer-ce:latest", { theme: "dark" })
      .icon,
    "portainer-dark",
  );
  assert.equal(
    resolveContainerIcon("private.example/custom:1", { iconKey: "redis" })
      .source,
    "override",
  );
  assert.equal(
    resolveContainerIcon("redis", { iconKey: "https://example.com/logo.svg" })
      .source,
    "fallback",
  );
  assert.equal(resolveContainerIcon("mycorp/redis").fallback.name, "database");
});

test("reviewed sources compile offline to complete, safe geometry with original fills and strokes", () => {
  const pack = buildBrandPack();
  assert.deepEqual(pack, buildBrandPack());
  for (const [key, brand] of Object.entries(brands))
    for (const icon of [key, brand.light, brand.dark].filter(Boolean))
      assert.ok(pack.icons[icon]?.nodes.length, icon);
  assert.equal(pack.icons.portainer.nodes.length, 2);
  assert.equal(pack.icons.appsmith.viewBox, "0 0 16 16");
  assert.equal(pack.icons.appsmith.nodes.length, 5);
  assert.ok(
    pack.icons.appsmith.nodes.some(
      (node) =>
        node.attrs.fill === "#ffffff" &&
        node.attrs.y === "12" &&
        node.attrs.width === "12",
    ),
  );
  assert.equal(pack.icons["portainer-dark"].nodes[0].attrs.fill, "#F7F6F3");
  assert.ok(
    pack.icons.postgresql.nodes.some(
      (n) => n.attrs.stroke === "#fff" && n.attrs["stroke-width"] === "12.4651",
    ),
  );
  assert.ok(new Set(pack.icons.redis.nodes.map((n) => n.attrs.fill)).size > 2);
  for (const field of ["src", "svg", "url"]) {
    const altered = structuredClone(pack);
    altered.icons.redis[field] = "https://example.com/untrusted";
    assert.throws(() => validateBrandPack(altered));
  }
  const altered = structuredClone(pack);
  altered.icons.redis.nodes[0].attrs.onload = "alert(1)";
  assert.throws(() => validateBrandPack(altered));
});

test("changed icon source bytes fail the offline build instead of silently changing artwork", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-brands-"));
  try {
    fs.cpSync(new URL("../brands/", import.meta.url), directory, {
      recursive: true,
    });
    fs.appendFileSync(path.join(directory, "sources/redis.svg"), " ");
    assert.throws(() => buildBrandPack(directory), /integrity mismatch: redis/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("brand loading shares one local request and caches failure without external retries", async () => {
  let requests = 0,
    registrations = 0;
  const load = createBrandLoader({
    fetchPack: async (url) => {
      requests++;
      assert.equal(url, "/assets/container-brands.json");
      return { ok: true, text: async () => JSON.stringify(buildBrandPack()) };
    },
    registerPack: () => registrations++,
  });
  await Promise.all([load(), load(), load()]);
  assert.equal(requests, 1);
  assert.equal(registrations, 1);
  for (const response of [
    { ok: false },
    { ok: true, text: async () => "invalid json" },
    { ok: true, text: async () => JSON.stringify({ schema: "untrusted" }) },
  ]) {
    let failures = 0;
    const fail = createBrandLoader({
      fetchPack: async () => {
        failures++;
        return response;
      },
      registerPack: () => assert.fail("invalid pack registered"),
    });
    await assert.rejects(fail());
    await assert.rejects(fail());
    assert.equal(failures, 1);
  }
});

test("icon component preserves placeholders on errors and ignores stale asynchronous selections", async () => {
  const { JSDOM } = await import("../.framework/node_modules/jsdom/lib/api.js");
  const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
  for (const key of [
    "window",
    "document",
    "HTMLElement",
    "customElements",
    "CustomEvent",
    "AbortController",
    "MutationObserver",
  ])
    globalThis[key] = dom.window[key];
  const { XContainerIcon } = await import("../components/container-icon.mjs");
  const { registerIconPack } =
    await import("../.framework/components/xicon.js");
  const pack = buildBrandPack();
  registerIconPack(pack);
  let finish,
    calls = 0;
  class DelayedIcon extends XContainerIcon {
    static loadPack() {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
  }
  customElements.define("x-test-delayed-icon", DelayedIcon);
  const icon = document.createElement("x-test-delayed-icon");
  icon.image = "redis:7";
  document.body.append(icon);
  assert.equal(icon.snapshot().state, "loading");
  assert.equal(
    icon.shadowRoot.querySelector("x-icon").getAttribute("name"),
    "database",
  );
  icon.image = "mycorp/unknown:1";
  finish(pack);
  await Promise.resolve();
  assert.equal(icon.snapshot().state, "fallback");
  assert.equal(
    icon.shadowRoot.querySelector("x-icon").getAttribute("name"),
    "cube",
  );
  icon.image = "portainer/portainer-ce:latest";
  const oldFinish = finish;
  icon.theme = "dark";
  oldFinish(pack);
  await Promise.resolve();
  assert.equal(icon.snapshot().state, "loading");
  finish(pack);
  await Promise.resolve();
  assert.equal(icon.snapshot().state, "ready");
  assert.equal(
    icon.shadowRoot.querySelector("x-icon").getAttribute("name"),
    "portainer-dark",
  );
  assert.equal(
    icon.shadowRoot.querySelector("x-icon").shadowRoot.querySelectorAll("path")
      .length,
    2,
  );
  icon.remove();
  const previousCalls = calls;
  icon.image = "unknown:1";
  document.body.append(icon);
  assert.equal(calls, previousCalls);
  class FailedIcon extends XContainerIcon {
    static loadPack() {
      return Promise.reject(Error("offline asset"));
    }
  }
  customElements.define("x-test-failed-icon", FailedIcon);
  const failed = document.createElement("x-test-failed-icon");
  failed.image = "redis:7";
  document.body.append(failed);
  await Promise.resolve();
  assert.equal(failed.snapshot().state, "error");
  assert.equal(
    failed.shadowRoot.querySelector("x-icon").getAttribute("pack"),
    "lucide",
  );
  // Exercise the real table projection with an update candidate as well as the
  // leaf component. A render exception must not silently erase the inventory.
  await import("../components/widgets.mjs");
  const table = document.createElement("x-container-table");
  document.body.append(table);
  table.setAttribute(
    "data-view",
    JSON.stringify({
      containers: [
        {
          id: "test",
          name: "redis",
          image: "redis:7",
          state: "running",
          group: "Cache",
          candidate: { targetDigest: "sha256:" + "a".repeat(64) },
        },
      ],
      sort: "",
      filter: "all",
      query: "",
      theme: "dark",
    }),
  );
  assert.equal(table.vm.containers.length, 1);
  assert.equal(table.shadowRoot.querySelectorAll("x-container-icon").length, 1);
  assert.match(table.shadowRoot.textContent, /redis/);
  table.remove();
  failed.remove();
  icon.remove();
  dom.window.close();
});
