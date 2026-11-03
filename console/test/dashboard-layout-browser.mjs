// Disposable BFF plus demo data. An explicit origin also uses demo-only pages.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  process.env.CUO_PLAYWRIGHT_MODULE || "playwright"
);
const out = process.env.CUO_LAYOUT_OUTPUT || "reports/dashboard-layout-browser";
fs.mkdirSync(out, { recursive: true });
let origin = process.env.CUO_LAYOUT_ORIGIN,
  server,
  directory,
  browser,
  serverErrors = "";
const results = [],
  errors = [];
try {
  if (!origin) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-layout-"));
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["server/index.mjs"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        CUO_ORIGIN: origin,
        CUO_PORT: String(port),
        CUO_BIND: "127.0.0.1",
        CUO_AUTH_DATA: directory,
        CUO_CORE_URL: "http://127.0.0.1:1",
        CUO_CORE_TOKEN: "disposable-layout-test",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    server.stderr.on("data", (bytes) => (serverErrors += bytes));
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(origin + "/health")).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CUO_CHROMIUM
      ? { executablePath: process.env.CUO_CHROMIUM }
      : {}),
  });
  // Measure actual text lines; ancestor overflow:hidden cannot conceal failures.
  const inspect = async (page, fixtureOnly = false) =>
    page.evaluate((fixtureOnly) => {
      const failures = [];
      const bounds = (el) => {
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el);
        return {
          left:
            r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft),
          right:
            r.right -
            parseFloat(s.borderRightWidth) -
            parseFloat(s.paddingRight),
          top: r.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop),
          bottom:
            r.bottom -
            parseFloat(s.borderBottomWidth) -
            parseFloat(s.paddingBottom),
        };
      };
      const textInside = (el, label) => {
        const box = bounds(el),
          walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node; (node = walker.nextNode());) {
          if (!node.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const r of range.getClientRects())
            if (
              r.width > 0 &&
              r.height > 0 &&
              (r.left < box.left - 1 ||
                r.right > box.right + 1 ||
                r.top < box.top - 1 ||
                r.bottom > box.bottom + 1)
            )
              failures.push({
                label,
                text: node.textContent.slice(0, 90),
                box,
                rect: {
                  left: r.left,
                  right: r.right,
                  top: r.top,
                  bottom: r.bottom,
                },
              });
        }
      };
      const planner = document.querySelector(
        fixtureOnly
          ? "#layout-fixture x-maintenance-planner"
          : ".calendar-panel x-maintenance-planner",
      );
      const windowCard = planner.shadowRoot.querySelector(".window-card");
      textInside(windowCard, "maintenance window");
      const heading = windowCard.querySelector(".window-heading"),
        date = heading.querySelector("h3").getBoundingClientRect(),
        badge = heading.querySelector(".badge").getBoundingClientRect();
      if (
        Math.min(date.right, badge.right) >
          Math.max(date.left, badge.left) + 1 &&
        Math.min(date.bottom, badge.bottom) > Math.max(date.top, badge.top) + 1
      )
        failures.push({ label: "overlapping date and badge" });
      if (fixtureOnly) return { failures };
      document
        .querySelectorAll(".stat-card")
        .forEach((card) => textInside(card, "status card"));
      const grid = document.querySelector(".quick-actions"),
        buttons = [...grid.querySelectorAll(".quick-action")],
        rects = buttons.map((button) => button.getBoundingClientRect()),
        box = bounds(grid);
      buttons.forEach((button) => textInside(button, "quick action"));
      rects.forEach((r, i) => {
        if (r.left < box.left - 1 || r.right > box.right + 1)
          failures.push({ label: "quick action outside grid", index: i });
        if (Math.abs(r.width - rects[0].width) > 1)
          failures.push({ label: "unequal quick action widths" });
        rects.slice(i + 1).forEach((other) => {
          if (
            Math.min(r.right, other.right) > Math.max(r.left, other.left) + 1 &&
            Math.min(r.bottom, other.bottom) > Math.max(r.top, other.top) + 1
          )
            failures.push({ label: "overlapping quick actions" });
        });
      });
      return {
        failures,
        documentWidth: document.documentElement.scrollWidth,
        viewport: innerWidth,
        gridDisplay: getComputedStyle(grid).display,
        quickColumns:
          getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        statsColumns: getComputedStyle(
          document.querySelector(".stats"),
        ).gridTemplateColumns.split(" ").length,
        buttons: buttons.length,
      };
    }, fixtureOnly);
  for (const locale of ["de-DE", "en-GB"]) {
    const context = await browser.newContext({
      locale,
      viewport: { width: 1536, height: 1024 },
      reducedMotion: "reduce",
    });
    await context.addInitScript(
      ({ language }) =>
        localStorage.setItem(
          "cuo.demo.profile",
          JSON.stringify({
            displayName: "Layout fixture",
            theme: language === "en" ? "dark" : "light",
            palette: language === "en" ? "black" : "slate",
            language,
            languageAutomatic: false,
          }),
        ),
      { language: locale.slice(0, 2) },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(origin + "/?demo=1#/dashboard");
      await page.waitForFunction(
        () =>
          window.XTendMaraca?.model?.getState("cuo.vm")?.demo &&
          document.querySelector("x-cuo-sidebar-motion")?.snapshot().ready,
      );
      await page
        .locator(
          '.calendar-panel x-maintenance-planner .day[data-value="2026-11-03"]',
        )
        .click();
      await page.evaluate(() => document.fonts.ready);
      const widths = (
        process.env.CUO_LAYOUT_WIDTHS || "320,390,760,850,1050,1119,1300,1536"
      )
        .split(",")
        .map(Number);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 892 });
        await page.waitForFunction(
          (narrow) =>
            window.XTendMaraca.model.getState("cuo.vm").sidebarNarrow ===
            narrow,
          width <= 760,
        );
        for (const collapsed of [false, true]) {
          if (
            (await page.evaluate(
              () =>
                window.XTendMaraca.model.getState("cuo.vm").sidebarCollapsed,
            )) !== collapsed
          )
            await page.locator("#cuo-sidebar-toggle").click();
          await page.waitForFunction((collapsed) => {
            const vm = window.XTendMaraca.model.getState("cuo.vm"),
              motion = document
                .querySelector("x-cuo-sidebar-motion")
                .snapshot();
            return (
              vm.sidebarCollapsed === collapsed &&
              motion.active === 0 &&
              Math.abs(
                document.querySelector(".sidebar").getBoundingClientRect()
                  .width -
                  (collapsed
                    ? 76
                    : innerWidth <= 760
                      ? 248
                      : innerWidth <= 1300
                        ? 224
                        : 258),
              ) < 0.5
            );
          }, collapsed);
          const layout = await inspect(page);
          assert.deepEqual(
            layout.failures,
            [],
            JSON.stringify({ locale, width, collapsed, ...layout }),
          );
          assert.ok(layout.documentWidth <= width, JSON.stringify(layout));
          assert.equal(layout.gridDisplay, "grid");
          assert.equal(layout.buttons, 6);
          assert.ok(
            [1, 2, 3].includes(layout.quickColumns),
            JSON.stringify(layout),
          );
          assert.ok(
            [1, 2, 4].includes(layout.statsColumns),
            JSON.stringify(layout),
          );
          results.push({ locale, width, collapsed, ...layout });
          if ((width === 1119 && !collapsed) || (width === 390 && collapsed))
            await page.screenshot({
              path: path.join(
                out,
                `${locale}-${width}-${collapsed ? "rail" : "expanded"}.png`,
              ),
              fullPage: true,
            });
        }
      }
      // Public widget data contract: unbroken user-supplied maintenance names.
      await page.evaluate(() => {
        const holder = document.createElement("div");
        holder.id = "layout-fixture";
        holder.style.width = "202px";
        const widget = document.createElement("x-maintenance-planner"),
          vm = structuredClone(window.XTendMaraca.model.getState("cuo.vm"));
        vm.windows[0].name = "maintenance-" + "longgroupname".repeat(12);
        vm.selectedDate = "2026-11-03";
        widget.setAttribute("data-view", JSON.stringify(vm));
        holder.append(widget);
        document.body.append(holder);
      });
      await page.waitForFunction(
        () =>
          document
            .querySelector("#layout-fixture x-maintenance-planner")
            ?.shadowRoot.querySelector(".window-card") &&
          document
            .querySelector("#layout-fixture x-maintenance-planner")
            .shadowRoot.querySelector("link")?.sheet,
      );
      for (const width of [202, 280, 540]) {
        await page
          .locator("#layout-fixture")
          .evaluate((el, width) => (el.style.width = width + "px"), width);
        const layout = await inspect(page, true);
        assert.deepEqual(
          layout.failures,
          [],
          JSON.stringify({ locale, width, ...layout }),
        );
      }
    } catch (error) {
      await page.screenshot({
        path: path.join(out, "failure.png"),
        fullPage: true,
      });
      throw error;
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(
      { layouts: results, longWindowNames: true, errors },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `${results.length} dashboard layouts passed: DE/EN, expanded/rail, status text, maintenance bounds and quick-action grid; long names passed.`,
  );
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  if (serverErrors)
    fs.writeFileSync(path.join(out, "server.log"), serverErrors);
}
