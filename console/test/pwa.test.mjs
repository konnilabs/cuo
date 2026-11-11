import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { isPublicAsset, assetContentType } from "../server/public-assets.mjs";
import { pwaBuildFingerprint } from "../tools/pwa.mjs";

test("PWA delivery permits native outputs without opening reports or server files", () => {
  for (const name of [
    "/xtend.webmanifest",
    "/xtend.service-worker.js",
    "/xtend.offline.html",
    "/icons/android-chrome-512x512.png",
    "/icons/apple-touch-icon.png",
    "/assets/cuo-pwa-policy.js",
  ])
    assert.ok(isPublicAsset(name), name);
  for (const name of [
    "/server/xtend.maraca.services.mjs",
    "/xtend.webmanifest.report.json",
    "/xtend.pwa.report.json",
    "/.env",
    "/icons/../../server/index.mjs",
    "/icons/unreviewed.png",
    "/api/v1/file.css",
    "/auth/file.js",
  ])
    assert.equal(isPublicAsset(name), false, name);
  assert.match(
    assetContentType("/xtend.webmanifest"),
    /^application\/manifest\+json/,
  );
  assert.match(
    assetContentType("/xtend.service-worker.js"),
    /^text\/javascript/,
  );
  assert.equal(assetContentType("/icons/apple-touch-icon.png"), "image/png");
});

test("Maraca hook strictly bypasses auth, APIs, writes, query responses and cross-origin requests", () => {
  const publicFiles = [
    "/index.html",
    "/boot.mjs",
    "/assets/components.css",
    "/xtend.offline.html",
  ];
  const precache = ["/server/private.mjs", "/xtend.pwa.report.json"];
  let listener;
  const source = fs
    .readFileSync(new URL("../pwa/policy.js", import.meta.url), "utf8")
    .replace("/* CUO_PUBLIC_FILES */ []", JSON.stringify(publicFiles));
  vm.runInNewContext(source, {
    URL,
    Set,
    Request,
    XTEND_PRECACHE_URLS: precache,
    self: {
      location: {
        href: "https://cuo.example/xtend.service-worker.js",
        origin: "https://cuo.example",
      },
      addEventListener(type, fn) {
        assert.equal(type, "fetch");
        listener = fn;
      },
    },
  });
  assert.deepEqual(
    precache.map((request) => new URL(request.url).pathname),
    publicFiles,
  );
  assert.ok(
    precache.every(
      (request) => request.cache === "reload" && request.credentials === "omit",
    ),
  );
  const allowed = [
    ["/", "GET", "navigate"],
    ["/?login_error=oidc", "GET", "navigate"],
    ["/index.html", "GET", "navigate"],
    ["/boot.mjs", "GET", "cors"],
    ["/assets/components.css", "GET", "cors"],
  ];
  const bypassed = [
    ["/auth/oidc/start", "GET", "navigate"],
    ["/auth/oidc/callback?code=secret", "GET", "navigate"],
    ["/auth/session", "GET", "cors"],
    ["/api/v1/export.css", "GET", "cors"],
    ["/boot.mjs?personal=1", "GET", "cors"],
    ["/boot.mjs", "POST", "cors"],
    ["https://other.example/boot.mjs", "GET", "cors"],
    ["/boot.mjs", "GET", "cors", "Bearer secret"],
  ];
  for (const [cases, bypass] of [
    [allowed, false],
    [bypassed, true],
  ])
    for (const [url, method, mode, authorization] of cases) {
      let stopped = false;
      listener({
        request: {
          url: new URL(url, "https://cuo.example").href,
          method,
          mode,
          headers: new Headers(authorization ? { authorization } : {}),
        },
        stopImmediatePropagation() {
          stopped = true;
        },
      });
      assert.equal(stopped, bypass, url);
    }
});

test("copied CSS, icons, policy and dependency changes invalidate the native cache key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-pwa-inputs-"));
  try {
    for (const directory of [
      "src",
      "components",
      "shared",
      "i18n",
      "assets",
      "pwa",
      "tools",
      "vendor",
    ]) {
      fs.mkdirSync(path.join(root, directory));
      fs.writeFileSync(path.join(root, directory, "input"), "original");
    }
    fs.mkdirSync(path.join(root, "server"));
    fs.writeFileSync(path.join(root, "server/public-assets.mjs"), "allowlist");
    for (const name of [
      "maraca.config.json",
      "xtend.lock.json",
      "package.json",
    ])
      fs.writeFileSync(path.join(root, name), "{}");
    const original = pwaBuildFingerprint(root);
    assert.equal(pwaBuildFingerprint(root), original);
    for (const name of ["assets/input", "pwa/input", "xtend.lock.json"]) {
      const file = path.join(root, name),
        before = fs.readFileSync(file);
      fs.appendFileSync(file, "changed");
      assert.notEqual(pwaBuildFingerprint(root), original, name);
      fs.writeFileSync(file, before);
    }
    fs.writeFileSync(path.join(root, "assets/new-icon.png"), "new");
    assert.notEqual(pwaBuildFingerprint(root), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Trusted Types permits only the exact same-origin native worker URL", async () => {
  const originalLocation = globalThis.location,
    originalTypes = globalThis.trustedTypes;
  try {
    globalThis.location = { origin: "https://cuo.example" };
    let rules;
    globalThis.trustedTypes = {
      createPolicy(name, value) {
        assert.equal(name, "cuo-service-worker");
        rules = value;
        return value;
      },
    };
    const { serviceWorkerUrl } = await import("../pwa/registration.mjs");
    assert.equal(
      serviceWorkerUrl(),
      "https://cuo.example/xtend.service-worker.js",
    );
    for (const url of [
      "https://other.example/xtend.service-worker.js",
      "https://cuo.example/xtend.service-worker.js?code=private",
      "https://cuo.example/other.js",
    ])
      assert.throws(() => rules.createScriptURL(url));
    assert.deepEqual(Object.keys(rules), ["createScriptURL"]);
  } finally {
    globalThis.location = originalLocation;
    globalThis.trustedTypes = originalTypes;
  }
});
