import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isPublicAsset } from "../server/public-assets.mjs";
const { chromium } = await import(
  process.env.CUO_PLAYWRIGHT_MODULE || "playwright"
);
const root = fileURLToPath(new URL("..", import.meta.url));
const out =
  process.env.CUO_PWA_OUTPUT || path.join(root, "reports/pwa-browser");
fs.mkdirSync(out, { recursive: true });
fs.rmSync(path.join(out, "diagnostics.json"), { force: true });
let origin = process.env.CUO_PWA_ORIGIN,
  fixture,
  server,
  browser;
const errors = [],
  diagnostics = [];
const profiles = [];
const report = { samples: [], cacheRotation: false };
try {
  if (!origin) {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-pwa-"));
    for (const directory of ["dist", "server"])
      fs.cpSync(path.join(root, directory), path.join(fixture, directory), {
        recursive: true,
      });
    for (const directory of ["runtime", ".framework", "shared"])
      fs.symlinkSync(path.join(root, directory), path.join(fixture, directory));
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    origin = "http://127.0.0.1:" + port;
    server = spawn(process.execPath, [path.join(fixture, "server/index.mjs")], {
      env: {
        ...process.env,
        CUO_AUTH_DATA: path.join(fixture, "identity"),
        CUO_ORIGIN: origin,
        CUO_PORT: String(port),
        CUO_BIND: "127.0.0.1",
        CUO_CORE_URL: "http://127.0.0.1:1",
        CUO_CORE_TOKEN: "pwa-fixture-only",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    server.stderr.on("data", (data) => diagnostics.push(String(data)));
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + "/health")).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  for (const [mode, width] of [
    ["light", 1280],
    ["dark", 390],
  ]) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-pwa-browser-"));
    profiles.push(profile);
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      ...(process.env.CUO_CHROMIUM
        ? { executablePath: process.env.CUO_CHROMIUM }
        : {}),
      colorScheme: mode,
      locale: "de-DE",
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    browser = context;
    context.on("console", (message) => {
      if (/XTend Maraca PWA|Cache\.addAll|Failed to fetch/.test(message.text()))
        diagnostics.push(message.text());
    });
    const page = await context.newPage();
    const workerCdp = await context.newCDPSession(page);
    workerCdp.on("ServiceWorker.workerErrorReported", (event) =>
      diagnostics.push(event.errorMessage),
    );
    await workerCdp.send("ServiceWorker.enable");
    page.setDefaultTimeout(12000);
    const deadline = setTimeout(() => context.close().catch(() => {}), 90000);
    let phase = "registration";
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning")
        diagnostics.push(msg.text());
    });
    try {
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.waitForFunction(() => !!window.__XTendMaracaPwaRegistration);
      const registration = await page.evaluate(
        () => window.__XTendMaracaPwaRegistration,
      );
      assert.equal(
        registration.status,
        "registered",
        JSON.stringify({ registration, diagnostics }),
      );
      await page.waitForFunction(
        async () => !!(await navigator.serviceWorker.getRegistration())?.active,
      );
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      console.log("PWA worker active: " + mode);
      phase = "manifest and cache";
      const manifestResponse = await context.request.get(
        origin + "/xtend.webmanifest",
      );
      assert.match(
        manifestResponse.headers()["content-type"],
        /^application\/manifest\+json/,
      );
      const manifest = await manifestResponse.json();
      assert.equal(manifest.short_name, "CUO");
      assert.equal(manifest.display, "standalone");
      const workerResponse = await context.request.get(
        origin + "/xtend.service-worker.js",
      );
      assert.equal(workerResponse.headers()["service-worker-allowed"], "/");
      assert.equal(workerResponse.headers()["cache-control"], "no-cache");
      assert.match(
        workerResponse.headers()["content-type"],
        /^text\/javascript/,
      );
      const documentResponse = await context.request.get(origin + "/");
      assert.match(
        documentResponse.headers()["content-security-policy"],
        /require-trusted-types-for 'script'/,
      );
      for (const url of [
        "/xtend.pwa.report.json",
        "/xtend.webmanifest.report.json",
        "/server/xtend.maraca.services.mjs",
        "/.env",
      ])
        assert.equal(
          (await context.request.get(origin + url)).status(),
          404,
          url,
        );
      assert.equal(
        (
          await context.request.head(origin + "/icons/apple-touch-icon.png")
        ).headers()["content-type"],
        "image/png",
      );
      for (const icon of manifest.icons) {
        const dimensions = await page.evaluate(async (src) => {
          const image = new Image();
          image.src = src;
          await image.decode();
          return `${image.naturalWidth}x${image.naturalHeight}`;
        }, icon.src);
        assert.equal(dimensions, icon.sizes);
      }
      assert.equal(
        await page.locator('link[rel="apple-touch-icon"]').getAttribute("href"),
        "/icons/apple-touch-icon.png",
      );
      const cdp = await context.newCDPSession(page);
      const installability = await cdp.send("Page.getInstallabilityErrors");
      assert.deepEqual(installability.installabilityErrors, []);
      const inventory = () =>
        page.evaluate(async () =>
          Object.fromEntries(
            await Promise.all(
              (await caches.keys()).map(async (key) => [
                key,
                (await (await caches.open(key)).keys()).map(
                  (request) => new URL(request.url).pathname,
                ),
              ]),
            ),
          ),
        );
      const before = await inventory();
      console.log("PWA manifest and public cache verified: " + mode);
      phase = "network boundaries";
      const urls = Object.values(before).flat();
      assert.ok(
        urls.includes("/boot.mjs") && urls.includes("/xtend.offline.html"),
      );
      assert.ok(urls.every(isPublicAsset));
      for (const url of [
        "/auth/session",
        "/api/v1/containers",
        "/api/v1/private.css",
        "/assets/missing.css?private=1",
      ])
        await page.evaluate(async (url) => {
          try {
            await fetch(url, { credentials: "omit" });
          } catch {}
        }, url);
      if (fixture)
        await page.evaluate(async () => {
          await fetch("/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
        });
      assert.deepEqual(
        await inventory(),
        before,
        "auth, APIs and writes cannot enter the cache",
      );
      if (fixture && mode === "light") {
        phase = "cache rotation";
        // A second generated-worker version at the same URL must replace the
        // cache and fetch changed public assets, without replaying app writes.
        const file = path.join(fixture, "dist/xtend.service-worker.js");
        const original = fs.readFileSync(file, "utf8");
        const oldVersion = original.match(
          /const XTEND_CACHE_VERSION = "([^"]+)"/,
        )[1];
        const newVersion = oldVersion + "-next-build";
        fs.appendFileSync(
          path.join(fixture, "dist/boot.mjs"),
          "\n// CUO_PWA_NEXT_BUILD\n",
        );
        fs.writeFileSync(file, original.replace(oldVersion, newVersion));
        await page.waitForFunction(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return (
            registration.active?.state === "activated" &&
            !registration.installing
          );
        });
        await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          await registration.update();
        });
        console.log("PWA update check completed");
        let rotation;
        for (let attempt = 0; attempt < 48; attempt++) {
          rotation = await page.evaluate(async (version) => {
            const keys = await caches.keys();
            const cache = await caches.open("xtend-precache-" + version);
            const response = await cache.match("/boot.mjs");
            const registration =
              await navigator.serviceWorker.getRegistration();
            return {
              keys,
              cachedUpdated: response
                ? (await response.text()).includes("CUO_PWA_NEXT_BUILD")
                : false,
              active: registration.active?.state,
              installing: registration.installing?.state,
            };
          }, newVersion);
          const retired = rotation.keys.every(
            (key) => !key.startsWith("xtend-") || key.endsWith(newVersion),
          );
          if (rotation.cachedUpdated && retired) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert.ok(
          rotation.cachedUpdated &&
            rotation.keys.every(
              (key) => !key.startsWith("xtend-") || key.endsWith(newVersion),
            ),
          JSON.stringify({ rotation, diagnostics }),
        );
        report.cacheRotation = true;
        console.log("PWA cache rotation verified");
      }
      phase = "offline boundaries";
      await context.setOffline(true);
      const offline = await page.evaluate(async () => {
        const result = {};
        for (const [url, method] of [
          ["/auth/session", "GET"],
          ["/api/v1/containers", "GET"],
          ["/api/v1/private.css", "GET"],
          ["/auth/login", "POST"],
        ]) {
          try {
            await fetch(url, { method });
            result[url] = "unexpected response";
          } catch {
            result[url] = "network required";
          }
        }
        return result;
      });
      assert.ok(
        Object.values(offline).every((value) => value === "network required"),
      );
      await page.goto(origin + "/?pwa-offline-test=1", { waitUntil: "load" });
      phase = "offline page";
      await page
        .getByText("CUO ist gerade offline.", { exact: false })
        .waitFor();
      assert.equal(await page.locator("button,input").count(), 0);
      assert.equal(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).colorScheme,
        ),
        "light dark",
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: path.join(out, "offline-" + mode + ".png"),
      });
      await context.setOffline(false);
      phase = "reconnection";
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.locator("x-cuo-auth .auth-card").waitFor();
      report.samples.push({
        mode,
        width,
        manifest: true,
        installabilityErrors: [],
        nativeRegistration: registration,
        publicCachedFiles: urls.length,
        privateRequestsRequireNetwork: true,
        offlineFallback: true,
        reconnected: true,
      });
    } catch (error) {
      diagnostics.push({ mode, phase });
      throw error;
    } finally {
      clearTimeout(deadline);
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  assert.ok(
    !diagnostics.some((message) =>
      /TrustedScriptURL|business logic import failed|pwa_registration_error/i.test(
        message,
      ),
    ),
    JSON.stringify(diagnostics),
  );
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(
      { ...report, origin, errors, verifiedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fs.writeFileSync(
    path.join(out, "diagnostics.json"),
    JSON.stringify({ errors, diagnostics }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  if (server) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  for (const profile of profiles)
    fs.rmSync(profile, { recursive: true, force: true });
}
