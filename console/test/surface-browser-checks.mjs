import assert from "node:assert/strict";

// Runs inside the isolated appearance harness, never against user data.
export async function verifySurfaceDesign(page, out) {
  // The palette matrix uses the real RMT demo preference path. Repeated test
  // changes must not consume the authenticated profile-write rate limit.
  const url = new URL(page.url());
  url.searchParams.set("demo", "1");
  await page.goto(url.href);
  await page.waitForFunction(() => {
    const vm = window.XTendMaraca?.model.getState("cuo.vm");
    return vm?.demo && vm.auth === "ready";
  });
  await page.evaluate(async () => {
    const fixture = document.createElement("section");
    fixture.id = "surface-fixture";
    fixture.style.cssText = "position:fixed;bottom:0;left:0;width:0;height:0;min-height:0;overflow:visible";
    const trigger = document.createElement("button");
    trigger.id = "surface-trigger";
    trigger.textContent = "Surface test";
    const modal = document.createElement("x-approval-dialog");
    modal.id = "surface-modal";
    modal.noticesState = "ready";
    const process = document.createElement("x-cuo-process-detail");
    process.id = "surface-process";
    for (const widget of [modal, process]) widget.addEventListener("xtend-command", (event) => {
      event.stopPropagation();
      if (event.detail.kind === "close") widget.vm = { ...widget.vm, dialog: "" };
      else widget.lastCommand = event.detail;
    });
    fixture.append(trigger, modal, process);
    document.body.append(fixture);
    await Promise.all([modal, process].map((widget) => {
      const link = widget.shadowRoot.querySelector("link");
      return link.sheet ? Promise.resolve() : new Promise((resolve, reject) => {
        link.addEventListener("load", resolve, { once: true });
        link.addEventListener("error", reject, { once: true });
      });
    }));
  });
  const samples = [];
  await page.evaluate(async () => {
    await window.XTendMaraca.dispatchCommand("cuo.intent", { kind: "highContrast", value: "false" });
  });
  await page.waitForFunction(() => document.querySelector(".cuo-root").dataset.contrast === "normal");
  for (const width of [390, 1119]) {
    await page.setViewportSize({ width, height: 892 });
    for (const palette of ["slate", "black", "green", "wine"]) {
      for (const theme of ["light", "dark"]) {
        await page.evaluate(async ({ palette }) => {
          await window.XTendMaraca.dispatchCommand("cuo.intent", { kind: "palette", value: palette });
        }, { palette });
        await page.waitForFunction((palette) => document.querySelector(".cuo-root").dataset.palette === palette, palette);
        await page.evaluate(async ({ theme }) => {
          await window.XTendMaraca.dispatchCommand("cuo.intent", { kind: "themeSet", value: String(theme === "dark") });
        }, { theme });
        await page.waitForFunction((theme) => document.querySelector(".cuo-root").dataset.theme === theme, theme);
        for (const kind of ["help", "container", "add", "windowDetails", "window", "policy", "exclude", "run", "approve", "cancel", "user", "processLoading", "process"]) {
          const process = kind.startsWith("process");
          const target = page.locator(process ? "#surface-process" : "#surface-modal");
          await page.locator("#surface-trigger").focus();
          await page.evaluate(({ kind, theme, palette, process }) => {
            const id = "a".repeat(64);
            const widget = document.querySelector(process ? "#surface-process" : "#surface-modal");
            const name = "A long container name for wrapping and layout checks ".repeat(3);
            widget.vm = {
              user: { role: "Owner" }, theme, palette, selected: id,
              dialog: process ? "process" : kind,
              containers: [{ id, name, image: "example/app:stable", state: "running", managed: true, mode: "manual", platform: "linux/amd64" }],
              policies: [{ id, scope: "container", target: id, mode: "automatic", concurrency: 1 }],
              windows: [{ id, name, days: [0, 1, 2, 3, 4, 5, 6], start: "03:00", timezone: "Europe/Berlin", durationMinutes: 60, enabled: true }],
              jobs: [{ id, name, state: "awaiting_approval" }], capabilities: [],
              processDetail: kind === "process" ? {
                run: { id, name, kind: "run", state: "succeeded", anomalies: [], jobIds: [id], containerIds: [id] },
                jobs: [], events: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, time: "2026-11-04T12:00:00Z", stage: "succeeded", severity: "info", message: "Original log data ".repeat(8) })),
              } : null,
            };
          }, { kind, theme, palette, process });
          const dialog = target.locator("dialog[open]");
          await dialog.waitFor();
          const close = dialog.locator(".dialog-close");
          assert.equal(await close.count(), 1, kind);
          assert.ok(await close.getAttribute("aria-label"));
          assert.equal(await close.textContent(), "");
          await close.locator("x-icon svg line").first().waitFor();
          await dialog.locator(".dialog-content").evaluateAll((nodes) => nodes.forEach((node) => node.scrollTop = node.scrollHeight));
          const geometry = await close.evaluate((button) => {
            const r = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, color: style.color, background: getComputedStyle(button.closest("dialog")).backgroundColor };
          });
          assert.ok(geometry.width >= 39.5 && geometry.height >= 39.5, JSON.stringify(geometry));
          assert.ok(geometry.x >= 0 && geometry.right <= width && geometry.y >= 0 && geometry.bottom < 892, JSON.stringify({ kind, ...geometry }));
          assert.notEqual(geometry.color, geometry.background);
          assert.equal(geometry.background, theme === "light" ? "rgb(255, 255, 255)" : {
            slate: "rgb(26, 38, 58)", black: "rgb(23, 23, 23)", green: "rgb(16, 44, 32)", wine: "rgb(52, 26, 38)",
          }[palette], `actual palette: ${palette} ${theme}`);
          assert.ok(await close.evaluate((button) => button.getRootNode().activeElement === button), "X receives initial focus");
          await page.keyboard.press("Shift+Tab");
          assert.equal(await target.evaluate((widget) => {
            const active = widget.shadowRoot.activeElement;
            return !!active && !!active.closest("dialog[open]");
          }), true, `keyboard focus remains in the modal: ${kind} ${width} ${palette} ${theme}`);
          if (kind === "policy") {
            const form = dialog.locator("form");
            for (const key of ["preserveSysAdmin", "preserveSysPtrace", "preserveDacReadSearch", "preserveHostPid"]) await form.locator(`[name="${key}"]`).check();
            await form.locator('[name="permissionReason"]').fill("Existing trusted monitoring rights");
            await form.locator('[name="permissionsConfirmed"]').check();
            await form.locator('button[type="submit"]').click();
            const command = await target.evaluate((widget) => widget.lastCommand);
            assert.equal(command.kind, "savePolicy");
            assert.equal(command.data.permissions.preserveSysAdmin, true);
            assert.equal(command.data.permissions.preserveHostPid, true);
            assert.equal(command.data.permissionsConfirmed, true);
          }
          if (palette === "black" && theme === "dark" && ["policy", "process"].includes(kind))
            await page.screenshot({ path: `${out}/surface-${kind}-${width}.png` });
          if (kind === "help" || process) await page.keyboard.press("Escape");
          else await close.click();
          await dialog.waitFor({ state: "hidden" });
          assert.equal(await page.locator("#surface-trigger").evaluate((button) => document.activeElement === button), true, "focus returns after dismissal");
          samples.push({ width, palette, theme, kind });
        }
      }
    }
  }
  await page.evaluate(() => document.querySelector("#surface-fixture").remove());
  return samples;
}
