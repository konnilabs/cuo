// Real RMT shell, BFF and profile SQLite; deterministic read-only Core fixture.
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
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-appearance-")),
  out = process.env.CUO_APPEARANCE_OUTPUT || "reports/appearance-browser";
fs.mkdirSync(out, { recursive: true });
const id = "1".repeat(32),
  jobId = "2".repeat(32);
const container = {
  id,
  name: "Einstellungen",
  image: "example/app:stable",
  imageId: "sha256:old",
  state: "running",
  platform: "linux/amd64",
  managed: true,
  excluded: false,
  mode: "scan-only",
  group: "Original group",
};
const job = {
  id: jobId,
  containerId: id,
  name: "Einstellungen",
  state: "succeeded",
  hostId: "local",
  createdAt: "2026-11-03T10:00:00Z",
  reason: "Gespeicherter Originaltext",
};
const retention = {
  policy: {
    revision: 1,
    enabled: false,
    days: 30,
    maxEvents: 100000,
    intervalHours: 24,
    lastDeleted: 0,
  },
  events: 1,
  databaseBytes: 4096,
  reusableBytes: 0,
  activeJobs: 0,
};
const processRun = {
  id: jobId,
  kind: "run",
  name: job.name,
  state: job.state,
  createdAt: job.createdAt,
  durationMs: 1000,
  queueMs: 0,
  baselineSamples: 0,
  baselineMs: 0,
  containerCount: 1,
  succeeded: 1,
  failed: 0,
  pending: 0,
  jobIds: [jobId],
  containerIds: [id],
  anomalies: [],
  skipped: [],
  requester: "Original actor",
  reason: job.reason,
};
const core = http.createServer((req, res) => {
  if (req.url.startsWith("/api/v1/events")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": fixture\n\n");
    return;
  }
  let data = { items: [] };
  if (req.url.startsWith("/api/v1/permissions/me"))
    data = { capabilities: ["inventory.read"], revision: 1 };
  else if (req.url.startsWith("/api/v1/containers"))
    data = { items: [container] };
  else if (req.url.startsWith("/api/v1/update-jobs")) data = { items: [job] };
  else if (req.url.startsWith("/api/v1/hosts"))
    data = { items: [{ id: "local", name: "Original host", connected: true }] };
  else if (req.url.startsWith("/api/v1/activity"))
    data = {
      items: [
        {
          id: 1,
          jobId,
          time: job.createdAt,
          operation: "update",
          stage: "succeeded",
          severity: "info",
          message: job.reason,
        },
      ],
    };
  else if (req.url === "/api/v1/log-retention") data = retention;
  else if (req.url.startsWith("/api/v1/process-runs/" + jobId))
    data = {
      run: processRun,
      jobs: [job],
      events: [],
      eventCount: 0,
      moreEvents: false,
      nextEventId: 0,
      logsPruned: false,
    };
  else if (req.url.startsWith("/api/v1/process-runs"))
    data = {
      items: [processRun],
      upcoming: [],
      total: 1,
      offset: 0,
      limit: 50,
    };
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Fixture is read-only" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
});
await new Promise((r) => core.listen(0, "127.0.0.1", r));
const probe = http.createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const origin = "http://127.0.0.1:" + port;
const server = spawn(process.execPath, ["server/index.mjs"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    ...process.env,
    CUO_AUTH_DATA: directory,
    CUO_ORIGIN: origin,
    CUO_PORT: String(port),
    CUO_BIND: "127.0.0.1",
    CUO_CORE_URL: "http://127.0.0.1:" + core.address().port,
    CUO_CORE_TOKEN: "appearance-test-only",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
server.stderr.on("data", (v) => (stderr += v));
let browser;
try {
  for (let n = 0; n < 150; n++) {
    try {
      if ((await fetch(origin + "/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CUO_CHROMIUM
      ? { executablePath: process.env.CUO_CHROMIUM }
      : {}),
  });
  const context = await browser.newContext({
      locale: "en-GB",
      colorScheme: "light",
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    }),
    page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  const state = () =>
    page.evaluate(() => window.XTendMaraca.model.getState("cuo.vm"));
  const wait = (fn) => page.waitForFunction(fn);
  await page.goto(origin);
  await wait(
    () => window.XTendMaraca?.model.getState("cuo.vm")?.auth === "enroll",
  );
  await page.getByLabel("Username", { exact: true }).fill("Einstellungen");
  await page
    .getByLabel("Password", { exact: true })
    .fill("temporary-preferences-password-4821");
  await page
    .getByRole("button", { name: "Create administrator", exact: true })
    .click();
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").auth === "ready",
  );
  assert.equal((await state()).locale, "en");
  assert.equal((await state()).languageAutomatic, true);
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.equal((await state()).user.name, "Einstellungen");
  assert.equal(await page.evaluate(() => window.xtendI18n.getLocale()), "en");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const workspace = page.locator('x-cuo-workspace[section="settings"]:visible');
  await workspace
    .getByRole("tab", { name: "Appearance", exact: true })
    .waitFor();
  assert.equal(await workspace.getByRole("radio").count(), 4);
  assert.equal(
    await workspace.getByLabel("Automatic", { exact: true }).isChecked(),
    true,
  );
  assert.equal(
    await page.locator(".global-search kbd").textContent(),
    "Alt + K",
  );
  assert.equal(await page.locator(".brand-name small").textContent(), "v0.3.0");
  assert.equal(
    (await (await context.request.get(origin + "/health")).json()).version,
    "0.3.0",
  );
  // Render the real widgets through their public VM contract, without remote
  // integrations or writes. Keep them outside the visible application surface.
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.id = "badge-fixtures";
    fixture.style.cssText = "position:fixed;left:-10000px;top:0;width:900px";
    for (const [tag, section] of [
      ["x-unioci-registry-list", ""],
      ["x-cuo-workspace", "users"],
      ["x-cuo-workspace", "integrations"],
    ]) {
      const widget = document.createElement(tag);
      if (section) widget.setAttribute("section", section);
      fixture.append(widget);
    }
    document.body.append(fixture);
  });
  await workspace.getByLabel("Automatic", { exact: true }).uncheck();
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").themeMode !== "system",
  );
  const contrasts = [];
  const toggle = async (locator, checked) => {
    const control = locator.getByRole("switch");
    if ((await control.isChecked()) !== checked) await control.press("Space");
  };
  const contrastSample = async () =>
    page.evaluate(() => {
      const root = document.querySelector(".cuo-root"),
        widget = document.querySelector('x-cuo-workspace[section="settings"]'),
        panel = widget.shadowRoot.querySelector(".settings-content"),
        style = getComputedStyle(panel),
        vars = getComputedStyle(root);
      return {
        palette: root.dataset.palette,
        theme: root.dataset.theme,
        contrast: root.dataset.contrast,
        text: style.color,
        surface: vars.getPropertyValue("--cuo-surface").trim(),
        muted: vars.getPropertyValue("--cuo-muted").trim(),
        border: vars.getPropertyValue("--cuo-border").trim(),
        primary: vars.getPropertyValue("--cuo-primary").trim(),
        ink: vars.getPropertyValue("--cuo-primary-ink").trim(),
      };
    });
  function rgb(value) {
    if (value.startsWith("#"))
      return value
        .slice(1)
        .match(/../g)
        .map((c) => parseInt(c, 16) / 255);
    return value
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number)
      .map((v) => v / 255);
  }
  function lum(value) {
    return rgb(value)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  }
  function ratio(a, b) {
    const x = lum(a),
      y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  const badgeChecks = [];
  const inspectBadges = async () => {
    const result = await page.evaluate(async () => {
      const vm = structuredClone(window.XTendMaraca.model.getState("cuo.vm")),
        fixture = document.querySelector("#badge-fixtures");
      vm.registries = ["ready", "failed", "unchecked"].map((status) => ({
        id: status,
        name: "Registry " + status,
        host: "registry.example.test",
        provider: "oci",
        status,
        enabled: true,
      }));
      vm.users = [
        {
          id: "badge-fixture-user",
          name: "A long user name with spacing",
          role: "Owner",
          hosts: ["local"],
        },
      ];
      const widgets = [...fixture.children];
      for (const widget of widgets) widget.vm = vm;
      await Promise.all(
        widgets.map((widget) => {
          const link = widget.shadowRoot.querySelector("link");
          return link.sheet
            ? Promise.resolve()
            : new Promise((resolve) =>
                link.addEventListener("load", resolve, { once: true }),
              );
        }),
      );
      const badges = widgets.flatMap((widget) =>
        [...widget.shadowRoot.querySelectorAll(".badge")].map((badge) => ({
          text: badge.textContent,
          className: badge.className,
          color: getComputedStyle(badge).color,
          background: getComputedStyle(badge).backgroundColor,
          surface: getComputedStyle(badge)
            .getPropertyValue("--cuo-surface")
            .trim(),
        })),
      );
      const headings = widgets.flatMap((widget) =>
        [...widget.shadowRoot.querySelectorAll(".policy-heading")].map(
          (heading) => {
            const title = heading.querySelector("h3").getBoundingClientRect(),
              badge = heading.querySelector(".badge").getBoundingClientRect();
            return Math.min(title.bottom, badge.bottom) >
              Math.max(title.top, badge.top)
              ? badge.left - title.right
              : badge.top - title.bottom;
          },
        ),
      );
      return {
        palette: vm.palette,
        theme: vm.theme,
        highContrast: vm.highContrast,
        badges,
        headings,
      };
    });
    assert.equal(
      result.badges.filter((badge) => badge.className.includes("good")).length,
      2,
    );
    assert.ok(
      result.badges.some((badge) => badge.className.includes("warning")),
    );
    for (const badge of result.badges) {
      assert.ok(!badge.background.endsWith(", 0)"), JSON.stringify(badge));
      assert.ok(
        ratio(badge.color, badge.background) >= 4.5,
        JSON.stringify(badge),
      );
      if (!result.highContrast)
        assert.notEqual(lum(badge.background), lum(badge.surface));
    }
    assert.equal(result.headings.length, 2);
    assert.ok(
      result.headings.every((gap) => gap >= 7.5),
      JSON.stringify(result.headings),
    );
    badgeChecks.push(result);
  };
  const navigationChecks = [];
  const inspectNavigation = async () => {
    const snapshot = await page.evaluate(() => {
      const root = document.querySelector(".cuo-root"),
        sidebar = document.querySelector(".sidebar");
      return {
        palette: root.dataset.palette,
        theme: root.dataset.theme,
        contrast: root.dataset.contrast,
        collapsed: window.XTendMaraca.model.getState("cuo.vm").sidebarCollapsed,
        forcedColors: matchMedia("(forced-colors:active)").matches,
        items: [...sidebar.querySelectorAll(".nav-item")].map((button) => {
          const icon = button.querySelector("x-icon"),
            svg = icon.shadowRoot.querySelector("svg"),
            label = button.querySelector("[data-sidebar-label]"),
            badge = button.querySelector(".nav-badge"),
            selected = button.classList.contains("active");
          return {
            route: button.dataset.value,
            selected,
            color: getComputedStyle(button).color,
            label: getComputedStyle(label).color,
            icon: getComputedStyle(icon).color,
            renderedIcon: svg && getComputedStyle(svg).color,
            background: getComputedStyle(selected ? button : sidebar)
              .backgroundColor,
            badge: badge && {
              color: getComputedStyle(badge).color,
              background: getComputedStyle(badge).backgroundColor,
            },
          };
        }),
      };
    });
    assert.equal(snapshot.items.filter((item) => item.selected).length, 1);
    for (const item of snapshot.items) {
      const evidence = JSON.stringify({ ...snapshot, items: undefined, item });
      assert.equal(item.icon, item.label, evidence);
      assert.equal(item.renderedIcon, item.icon, evidence);
      assert.ok(ratio(item.icon, item.background) >= 3, evidence);
      assert.ok(ratio(item.label, item.background) >= 4.5, evidence);
      if (item.badge && !snapshot.forcedColors)
        assert.ok(
          ratio(item.badge.color, item.badge.background) >= 4.5,
          evidence,
        );
    }
    navigationChecks.push({
      ...snapshot,
      items: undefined,
      selectedRoute: snapshot.items.find((item) => item.selected).route,
      icons: snapshot.items.length,
    });
  };
  const inspectToggle = async (control) => {
    const sample = await control.evaluate((host) => {
      const root = host.shadowRoot,
        label = root.querySelector('[part="label"]'),
        state = root.querySelector(
          host.checked ? ".state-label-on" : ".state-label-off",
        ),
        slot = state.querySelector("slot"),
        text = slot.assignedElements()[0],
        inactive = root
          .querySelector(host.checked ? ".state-label-off" : ".state-label-on")
          .querySelector("slot")
          .assignedElements()[0],
        track = root.querySelector('[part="track"]'),
        thumb = root.querySelector('[part="thumb"]'),
        labelRect = text.getBoundingClientRect(),
        stateRect = state.getBoundingClientRect(),
        thumbRect = thumb.getBoundingClientRect();
      return {
        checked: host.checked,
        label: getComputedStyle(label).color,
        surface: getComputedStyle(host)
          .getPropertyValue("--cuo-surface")
          .trim(),
        stateText: getComputedStyle(state).color,
        track: getComputedStyle(track).backgroundColor,
        textWidth: labelRect.width,
        availableWidth: stateRect.width,
        activeVisibility: getComputedStyle(text).visibility,
        inactiveVisibility: getComputedStyle(inactive).visibility,
        clearOfThumb: host.checked
          ? labelRect.right <= thumbRect.left
          : labelRect.left >= thumbRect.right,
      };
    });
    assert.ok(
      ratio(sample.label, sample.surface) >= 4.5,
      JSON.stringify(sample),
    );
    assert.ok(
      ratio(sample.stateText, sample.track) >= 4.5,
      JSON.stringify(sample),
    );
    assert.ok(
      sample.textWidth <= sample.availableWidth + 1,
      JSON.stringify(sample),
    );
    assert.equal(sample.clearOfThumb, true, JSON.stringify(sample));
    assert.equal(sample.activeVisibility, "visible", JSON.stringify(sample));
    assert.equal(sample.inactiveVisibility, "hidden", JSON.stringify(sample));
  };
  for (const theme of ["light", "dark"]) {
    await toggle(
      workspace.locator("x-toggle[data-appearance-toggle]"),
      theme === "dark",
    );
    await page.waitForFunction(
      (value) =>
        window.XTendMaraca.model.getState("cuo.vm").theme === value &&
        document.querySelector(".cuo-root")?.dataset.theme === value,
      theme,
    );
    for (const [palette, label] of [
      ["slate", "Slate"],
      ["black", "Black"],
      ["green", "Forest green"],
      ["wine", "Burgundy"],
    ]) {
      await workspace.getByRole("radio", { name: label, exact: true }).check();
      await page.waitForFunction(
        (v) =>
          window.XTendMaraca.model.getState("cuo.vm").palette === v &&
          document.querySelector(".cuo-root")?.dataset.palette === v,
        palette,
      );
      let values = await contrastSample();
      assert.equal(values.palette, palette);
      assert.equal(values.theme, theme);
      assert.ok(
        ratio(values.text, values.surface) >= 4.5,
        JSON.stringify(values),
      );
      assert.ok(
        ratio(values.muted, values.surface) >= 4.5,
        JSON.stringify(values),
      );
      assert.ok(
        ratio(values.ink, values.primary) >= 4.5,
        JSON.stringify(values),
      );
      contrasts.push(values);
      await inspectNavigation();
      await inspectBadges();
      if (palette === "black" && theme === "dark") {
        const routes = await page
          .locator(".sidebar .nav-item")
          .evaluateAll((buttons) =>
            buttons.map((button) => button.dataset.value),
          );
        for (const route of routes) {
          await page
            .locator(`.sidebar .nav-item[data-value="${route}"]`)
            .click();
          await page
            .locator(`.sidebar .nav-item.active[data-value="${route}"]`)
            .waitFor();
          await inspectNavigation();
        }
        await page.locator('.sidebar .nav-item[data-value="settings"]').click();
        await page
          .locator('.sidebar .nav-item.active[data-value="settings"]')
          .waitFor();
        await page.locator("#cuo-sidebar-toggle").click();
        await wait(
          () => window.XTendMaraca.model.getState("cuo.vm").sidebarCollapsed,
        );
        await page.locator(".sidebar .nav-item.active").hover();
        await inspectNavigation();
        await page.screenshot({
          path: path.join(out, "black-dark-sidebar.png"),
          fullPage: true,
        });
        await page.locator("#cuo-sidebar-toggle").click();
        await wait(
          () => !window.XTendMaraca.model.getState("cuo.vm").sidebarCollapsed,
        );
      }
      await workspace
        .getByRole("tab", { name: "Accessibility", exact: true })
        .click();
      await inspectToggle(workspace.locator("x-toggle[data-high-contrast]"));
      await toggle(workspace.locator("x-toggle[data-high-contrast]"), true);
      await wait(
        () =>
          window.XTendMaraca.model.getState("cuo.vm").highContrast &&
          document.querySelector(".cuo-root")?.dataset.contrast === "high",
      );
      values = await contrastSample();
      assert.equal(values.contrast, "high");
      assert.ok(ratio(values.text, values.surface) >= 7);
      assert.ok(ratio(values.border, values.surface) >= 3);
      await inspectToggle(workspace.locator("x-toggle[data-high-contrast]"));
      contrasts.push(values);
      await inspectNavigation();
      await inspectBadges();
      if (palette === "wine")
        await page.screenshot({
          path: path.join(out, "contrast-" + theme + ".png"),
          fullPage: true,
        });
      await toggle(workspace.locator("x-toggle[data-high-contrast]"), false);
      await wait(
        () =>
          !window.XTendMaraca.model.getState("cuo.vm").highContrast &&
          document.querySelector(".cuo-root")?.dataset.contrast === "normal",
      );
      await workspace
        .getByRole("tab", { name: "Appearance", exact: true })
        .click();
    }
  }
  console.log(
    "All four palettes passed normal/high contrast checks in light and dark modes.",
  );
  await page.screenshot({
    path: path.join(out, "wine-dark.png"),
    fullPage: true,
  });
  await workspace.getByRole("tab", { name: "Language", exact: true }).click();
  const auto = workspace.getByLabel("Use browser language automatically");
  assert.equal(await auto.isChecked(), true);
  assert.equal(
    await workspace.getByLabel("Display language").isDisabled(),
    true,
  );
  await auto.uncheck();
  await wait(
    () => !window.XTendMaraca.model.getState("cuo.vm").languageAutomatic,
  );
  await workspace.getByLabel("Display language").selectOption("de");
  await wait(() => window.XTendMaraca.model.getState("cuo.vm").locale === "de");
  assert.equal(await page.locator("html").getAttribute("lang"), "de");
  await workspace.getByRole("tab", { name: "Daten & Sitzung" }).waitFor();
  await page.reload();
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").auth === "ready",
  );
  let vm = await state();
  assert.equal(vm.locale, "de");
  assert.equal(vm.languageAutomatic, false);
  assert.equal(vm.palette, "wine");
  assert.equal(vm.theme, "dark");
  assert.equal(vm.user.name, "Einstellungen");
  assert.equal(vm.user.role, "Owner");
  const selected = workspace.getByRole("tab", {
    name: "Darstellung",
    exact: true,
  });
  await selected.focus();
  await selected.press("End");
  await workspace
    .getByRole("tab", { name: "Daten & Sitzung", selected: true })
    .waitFor();
  await workspace.getByRole("tab", { name: "Daten & Sitzung" }).press("Home");
  await workspace
    .getByRole("tab", { name: "Darstellung", exact: true, selected: true })
    .waitFor();
  await workspace.getByRole("tab", { name: "Sprache", exact: true }).click();
  // German state labels are longer than ON/OFF. Inspect their actual rendered
  // bounds and label colors, including the native component's shadow styles.
  await workspace
    .getByRole("tab", { name: "Barrierefreiheit", exact: true })
    .click();
  await inspectToggle(workspace.locator("x-toggle[data-high-contrast]"));
  await toggle(workspace.locator("x-toggle[data-high-contrast]"), true);
  await wait(
    () => document.querySelector(".cuo-root")?.dataset.contrast === "high",
  );
  await inspectToggle(workspace.locator("x-toggle[data-high-contrast]"));
  await toggle(workspace.locator("x-toggle[data-high-contrast]"), false);
  await wait(
    () => document.querySelector(".cuo-root")?.dataset.contrast === "normal",
  );
  await workspace.getByRole("tab", { name: "Sprache", exact: true }).click();
  await workspace
    .getByLabel("Sprache automatisch vom Browser übernehmen")
    .check();
  await wait(() => window.XTendMaraca.model.getState("cuo.vm").locale === "en");
  await page.getByRole("button", { name: "Container", exact: true }).click();
  const table = page.locator("x-container-table:visible");
  await table.getByRole("columnheader", { name: /Name/ }).waitFor();
  assert.match(await table.locator("tbody").textContent(), /Einstellungen/);
  assert.match(await table.locator("tbody").textContent(), /Scan only/);
  await page.getByRole("button", { name: "Processes", exact: true }).click();
  await page
    .locator("x-cuo-process-manager:visible")
    .getByRole("button", { name: "Details", exact: true })
    .click();
  const details = page.locator("x-cuo-process-detail dialog");
  await details
    .getByRole("heading", { name: "Anomalies & data quality" })
    .waitFor();
  assert.match(await details.textContent(), /Gespeicherter Originaltext/);
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Open your profile", exact: true })
    .click();
  const drawer = page.locator("x-cuo-profile x-drawer");
  await drawer
    .getByRole("heading", { name: "Einstellungen", exact: true })
    .waitFor();
  const bg = await drawer
    .locator(".drawer")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(bg, "rgb(52, 26, 38)");
  const profileToggle = drawer.locator("x-toggle[data-appearance-toggle]");
  await inspectToggle(profileToggle);
  await toggle(profileToggle, false);
  await wait(
    () => document.querySelector(".cuo-root")?.dataset.theme === "light",
  );
  await inspectToggle(profileToggle);
  await toggle(profileToggle, true);
  await wait(
    () => document.querySelector(".cuo-root")?.dataset.theme === "dark",
  );
  await inspectToggle(profileToggle);
  await page.screenshot({
    path: path.join(out, "profile-wine.png"),
    fullPage: true,
  });
  await drawer
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await workspace.getByRole("tab", { name: "Language", exact: true }).click();
  assert.ok(
    await workspace
      .getByRole("combobox")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize) >= 16),
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: path.join(out, "mobile-settings.png"),
    fullPage: true,
  });
  await page.emulateMedia({ forcedColors: "active" });
  assert.equal(
    await page.evaluate(() => matchMedia("(forced-colors:active)").matches),
    true,
  );
  await inspectNavigation();
  await page.screenshot({
    path: path.join(out, "forced-colors.png"),
    fullPage: true,
  });
  await page.emulateMedia({ forcedColors: "none" });

  await workspace
    .getByRole("tab", { name: "Accessibility", exact: true })
    .click();
  await toggle(workspace.locator("x-toggle[data-high-contrast]"), true);
  await wait(
    () =>
      window.XTendMaraca.model.getState("cuo.vm").highContrast &&
      document.querySelector(".cuo-root")?.dataset.contrast === "high",
  );
  await page
    .getByRole("button", { name: "Open your profile", exact: true })
    .click();
  await drawer
    .getByRole("button", { name: "Save profile", exact: true })
    .click();
  const toast = page.locator("x-cuo-toasts x-toast").last().getByRole("status");
  await toast.waitFor();
  const toastColors = await toast.evaluate((el) => ({
    text: getComputedStyle(el).color,
    background: getComputedStyle(el).backgroundColor,
  }));
  assert.ok(ratio(toastColors.text, toastColors.background) >= 7);
  await page.screenshot({
    path: path.join(out, "contrast-toast-drawer.png"),
    fullPage: true,
  });
  await drawer
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  // System language changes refresh automatic mode without saving profile data.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["de-CH"],
    });
    window.dispatchEvent(new Event("languagechange"));
  });
  await wait(() => window.XTendMaraca.model.getState("cuo.vm").locale === "de");
  assert.equal(await page.locator("html").getAttribute("lang"), "de");
  const unsupported = await browser.newContext({ locale: "ja-JP" });
  const login = await unsupported.newPage();
  await login.goto(origin);
  await login.getByLabel("Username", { exact: true }).waitFor();
  assert.equal(await login.locator("html").getAttribute("lang"), "en");
  await unsupported.close();
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(
      {
        palettesAndContrast: contrasts,
        navigationContrast: navigationChecks,
        badgeContrastAndCardSpacing: badgeChecks,
        browserAutomaticDefault: true,
        manualAndAutomaticLanguage: true,
        languageChangeEvent: true,
        unsupportedFallback: "en",
        profilePersistence: true,
        highContrastToastOverDrawer: true,
        inactiveToggleLabelHidden: true,
        profileToggleBothStates: true,
        dataAndNamesPreserved: true,
        keyboardTabs: true,
        mobile: true,
        forcedColorsSmoke: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Native i18n, persisted preferences, keyboard tabs, original data, profile overlay and mobile checks passed.",
  );
} catch (error) {
  fs.writeFileSync(path.join(out, "server-errors.log"), stderr);
  if (browser) {
    for (const context of browser.contexts())
      for (const page of context.pages()) {
        try {
          await page.screenshot({
            path: path.join(out, "failure.png"),
            fullPage: true,
          });
        } catch {}
      }
  }
  throw error;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  core.closeAllConnections();
  await new Promise((r) => core.close(r));
  fs.rmSync(directory, { recursive: true, force: true });
}
