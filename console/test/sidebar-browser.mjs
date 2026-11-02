// Disposable BFF/identity fixture. Demo-only interaction never mutates Docker.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  process.env.CUO_PLAYWRIGHT_MODULE || "playwright"
);
const out = process.env.CUO_SIDEBAR_OUTPUT || "reports/sidebar-browser";
fs.mkdirSync(out, { recursive: true });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-sidebar-"));
const probe = http.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server/index.mjs"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    ...process.env,
    CUO_ORIGIN: origin,
    CUO_BIND: "127.0.0.1",
    CUO_PORT: String(port),
    CUO_AUTH_DATA: directory,
    CUO_CORE_URL: "http://127.0.0.1:1",
    CUO_CORE_TOKEN: "disposable-sidebar-test",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverErrors = "",
  browser;
server.stderr.on("data", (bytes) => (serverErrors += bytes));
const checks = [],
  errors = [];
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(origin + "/health")).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CUO_CHROMIUM
      ? { executablePath: process.env.CUO_CHROMIUM }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1536, height: 1024 },
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.sidebarEvents = [];
    window.addEventListener("xtend-rmt:animation-start", (event) => {
      if (event.detail.animation?.startsWith("cuo.sidebar."))
        window.sidebarEvents = [...window.sidebarEvents, event.detail].slice(
          -80,
        );
    });
  });
  const ready = async (p = page) =>
    p.waitForFunction(
      () =>
        window.XTendMaraca?.model?.getState("cuo.vm")?.demo &&
        document.querySelector("x-cuo-sidebar-motion")?.snapshot().ready,
    );
  const settled = async (collapsed, p = page) => {
    await p.waitForFunction((expected) => {
      const vm = window.XTendMaraca.model.getState("cuo.vm");
      const widget = document.querySelector("x-cuo-sidebar-motion");
      const width = document
        .querySelector(".sidebar")
        .getBoundingClientRect().width;
      return (
        vm.sidebarCollapsed === expected &&
        widget.snapshot().active === 0 &&
        Math.abs(
          width -
            (expected
              ? 76
              : innerWidth <= 760
                ? 248
                : innerWidth <= 1300
                  ? 224
                  : 258),
        ) < 0.5
      );
    }, collapsed);
  };
  await page.goto(origin + "/?demo=1#/dashboard");
  await ready();
  assert.equal(
    await page.locator("#cuo-sidebar-toggle").getAttribute("aria-expanded"),
    "true",
  );
  const samples = await page.evaluate(async () => {
    document.querySelector("#cuo-sidebar-toggle").click();
    const samples = [];
    for (let i = 0; i < 28; i++) {
      await new Promise(requestAnimationFrame);
      samples.push({
        sidebar: document.querySelector(".sidebar").getBoundingClientRect()
          .width,
        content: document.querySelector(".main-shell").getBoundingClientRect()
          .left,
      });
    }
    return samples;
  });
  await settled(true);
  assert.ok(
    samples.some((sample) => sample.sidebar > 80 && sample.sidebar < 250),
    "There must be visible intermediate widths",
  );
  assert.ok(
    samples.every((sample) => Math.abs(sample.sidebar - sample.content) < 1),
    "Content must move with the rail",
  );
  let snapshot = await page
    .locator("x-cuo-sidebar-motion")
    .evaluate((element) => element.snapshot());
  assert.ok(snapshot.last.results.length >= 15);
  assert.ok(
    snapshot.last.results.every(
      (result) =>
        result.result.engine === "web-animations" &&
        result.status === "complete",
    ),
  );
  assert.deepEqual(snapshot.last.diagnostics, []);
  assert.equal(
    await page.locator("#cuo-sidebar-toggle").getAttribute("aria-expanded"),
    "false",
  );
  assert.ok(await page.locator(".sidebar-arrow x-icon").locator("svg").count());
  await page.getByRole("button", { name: "Richtlinien", exact: true }).click();
  await page.waitForFunction(() => location.hash === "#/policies");
  await page.reload();
  await ready();
  await settled(true);
  assert.equal(await page.evaluate(() => location.hash), "#/policies");
  await page.screenshot({
    path: path.join(out, "compact-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Navigation ausklappen", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await settled(false);
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "cuo-sidebar-toggle",
  );
  await page.screenshot({
    path: path.join(out, "expanded-desktop.png"),
    fullPage: true,
  });
  checks.push(
    "RMT toggle, keyboard/focus, icon-only accessible names, route and reload persistence",
  );
  checks.push(
    "Native XTend AnimationEngine/WAAPI, AOT RMT presets, intermediate widths and synchronized content movement",
  );
  await page.evaluate(async () => {
    for (let i = 0; i < 9; i++) {
      document.querySelector("#cuo-sidebar-toggle").click();
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
  });
  await settled(true);
  snapshot = await page
    .locator("x-cuo-sidebar-motion")
    .evaluate((element) => element.snapshot());
  assert.deepEqual(snapshot.last.diagnostics, []);
  assert.equal(
    await page
      .locator(".sidebar")
      .evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState !== "finished").length,
      ),
    0,
  );
  await page.evaluate(() =>
    window.XTendMaraca.dispatchCommand("cuo.intent", {
      kind: "themeSet",
      value: "true",
    }),
  );
  await page.screenshot({
    path: path.join(out, "compact-dark.png"),
    fullPage: true,
  });
  checks.push(
    "Rapid reversal replaces active motion and releases native animation handles; dark mode",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .getByRole("button", { name: "Navigation ausklappen", exact: true })
    .click();
  await settled(false);
  const reduced = await page.evaluate(() => window.sidebarEvents.slice(-15));
  assert.ok(
    reduced.length &&
      reduced.every(
        (event) => event.durationMs === 0 && event.effect === "none",
      ),
  );
  checks.push(
    "Real prefers-reduced-motion disables movement while preserving both states",
  );
  const mobile = await context.newPage();
  mobile.on("pageerror", (error) => errors.push(error.message));
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(origin + "/?demo=1#/dashboard");
  await ready(mobile);
  await settled(true, mobile);
  for (const width of [390, 320]) {
    await mobile.setViewportSize({ width, height: 844 });
    const layout = await mobile.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      overflow: [
        ...document.querySelectorAll(
          ".main-shell, .topbar, .global-search, .main-content, .stats, .stat-card, .page-heading, .heading-actions, .dashboard-grid, .card",
        ),
      ].map((element) => ({
        class: element.className,
        width: element.getBoundingClientRect().width,
        right: element.getBoundingClientRect().right,
        min: getComputedStyle(element).minWidth,
      })),
    }));
    fs.writeFileSync(
      path.join(out, `mobile-${width}.json`),
      JSON.stringify(layout, null, 2),
    );
    await mobile.screenshot({
      path: path.join(out, `mobile-${width}.png`),
      fullPage: true,
    });
    assert.ok(
      await mobile.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert.ok(
      await mobile
        .locator(".quick-actions .btn")
        .evaluateAll((buttons) =>
          buttons.every(
            (button) => button.getBoundingClientRect().right <= innerWidth,
          ),
        ),
    );
  }
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.screenshot({
    path: path.join(out, "compact-mobile.png"),
    fullPage: true,
  });
  await mobile
    .getByRole("button", { name: "Navigation ausklappen", exact: true })
    .click();
  await settled(false, mobile);
  assert.equal(
    await mobile
      .locator(".main-shell")
      .evaluate((element) => element.getBoundingClientRect().left),
    76,
  );
  assert.equal(await mobile.locator(".sidebar-scrim").isVisible(), true);
  await mobile.screenshot({
    path: path.join(out, "expanded-mobile.png"),
    fullPage: true,
  });
  await mobile.keyboard.press("Escape");
  await settled(true, mobile);
  await mobile
    .getByRole("button", { name: "Navigation ausklappen", exact: true })
    .click();
  await settled(false, mobile);
  await mobile.getByRole("button", { name: "Logs", exact: true }).click();
  await settled(true, mobile);
  assert.equal(await mobile.evaluate(() => location.hash), "#/logs");
  await mobile.setViewportSize({ width: 1122, height: 892 });
  await settled(false, mobile);
  checks.push(
    "390/320px reflow, mobile icon rail, overlay, Escape, route auto-close and responsive desktop restoration",
  );
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(
      { passed: true, checks, samples, browserErrors: errors },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({ passed: true, checks, browserErrors: errors }, null, 2),
  );
} catch (error) {
  console.error(serverErrors.slice(-2000));
  throw error;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  fs.rmSync(directory, { recursive: true, force: true });
}
