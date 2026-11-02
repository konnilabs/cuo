// Run against a disposable CUO identity/Core datastore, never an enrolled user instance.
// CUO_TEST_ORIGIN defaults to the dev stack. Set CUO_PLAYWRIGHT_MODULE and
// CUO_CHROMIUM when using a bundled runtime instead of a local Playwright install.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
const { chromium } = await import(
  process.env.CUO_PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.CUO_TEST_ORIGIN || "http://127.0.0.1:8096",
  out = process.env.CUO_TEST_OUTPUT || "reports/browser";
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CUO_CHROMIUM
    ? { executablePath: process.env.CUO_CHROMIUM }
    : {}),
});
const context = await browser.newContext({
    viewport: { width: 1536, height: 1024 },
    reducedMotion: "reduce",
  }),
  page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (response) => {
  if (response.status() >= 400 && response.url().includes("/assets/"))
    errors.push("Asset HTTP " + response.status() + " " + response.url());
});
async function ready() {
  await page.waitForFunction(
    () => window.XTendMaraca?.model?.getState("cuo.vm")?.auth !== "loading",
  );
}
const model = () =>
  page.evaluate(() => window.XTendMaraca.model.getState("cuo.vm"));
try {
  await page.goto(origin + "/?demo=1");
  await ready();
  await page.screenshot({ path: out + "/dashboard.png", fullPage: true });
  assert.equal((await model()).demo, true);
  assert.equal(
    await page.locator("x-container-table:visible").locator("tbody tr").count(),
    8,
  );
  await page.getByRole("button", { name: "Container", exact: true }).click();
  await page.waitForFunction(
    () => window.XTendMaraca.model.getState("cuo.vm").page === "containers",
  );
  const table = page.locator("x-container-table:visible");
  await table
    .getByRole("textbox", { name: "Container suchen" })
    .fill("nextcloud");
  await page.waitForFunction(
    () => window.XTendMaraca.model.getState("cuo.vm").query === "nextcloud",
  );
  assert.equal(await table.locator("tbody tr").count(), 1);
  await table.locator(".name-link").click();
  await page
    .locator("x-approval-dialog")
    .locator("dialog")
    .waitFor({ state: "visible" });
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement.tagName),
    "X-APPROVAL-DIALOG",
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => window.XTendMaraca.model.getState("cuo.vm").dialog === "",
  );
  await page.getByRole("button", { name: "Farbschema wechseln" }).click();
  await page.waitForFunction(
    () => window.XTendMaraca.model.getState("cuo.vm").theme === "dark",
  );
  await page.screenshot({ path: out + "/dark.png", fullPage: true });
  // XSS values remain literal text inside the registered component boundary.
  await page.evaluate(() => {
    const table = document.querySelector("x-container-table");
    const vm = JSON.parse(table.getAttribute("data-view"));
    vm.containers[0].name = "<img src=x onerror=window.cuoXss=1>";
    vm.query = "";
    table.vm = vm;
  });
  assert.equal(
    await page.locator("x-container-table").first().locator("img").count(),
    0,
  );
  assert.equal(await page.evaluate(() => window.cuoXss), undefined);
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(origin + "/?demo=1");
  await mobile.waitForFunction(
    () => window.XTendMaraca?.model?.getState("cuo.vm")?.demo,
  );
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await mobile
    .getByRole("button", { name: "Navigation ausklappen", exact: true })
    .click();
  await mobile
    .getByRole("button", { name: "Richtlinien", exact: true })
    .click();
  await mobile.waitForFunction(
    () => window.XTendMaraca.model.getState("cuo.vm").page === "policies",
  );
  assert.equal(
    await mobile.evaluate(
      () => window.XTendMaraca.model.getState("cuo.vm").sidebarCollapsed,
    ),
    true,
  );
  await mobile.screenshot({ path: out + "/mobile.png", fullPage: true });
  await mobile.close();
  // The live branch requires fresh disposable auth storage.
  const probe = await context.request.get(origin + "/auth/session");
  const current = await probe.json();
  if (!current.enrollment)
    throw Error(
      "Live browser tests require an un-enrolled disposable instance",
    );
  await page.goto(origin + "/");
  await ready();
  const owner = "Test Owner " + randomUUID().slice(0, 6),
    password = randomUUID() + "#";
  const auth = page.locator("x-cuo-auth");
  await auth.getByLabel("Benutzername").fill(owner);
  await auth.getByLabel("Passwort", { exact: true }).fill(password);
  await auth.getByRole("button", { name: "Administrator anlegen" }).click();
  await page.waitForFunction(
    () => window.XTendMaraca.model.getState("cuo.vm").auth === "ready",
    { timeout: 30000 },
  );
  assert.equal((await model()).user.role, "Owner");
  assert.ok((await model()).containers.length > 0);
  await page
    .getByRole("button", { name: "Neues Wartungsfenster erstellen" })
    .click();
  const dialog = page.locator("x-approval-dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Browser Test");
  await dialog.getByRole("button", { name: "Fenster speichern" }).click();
  await page.waitForFunction(() =>
    window.XTendMaraca.model
      .getState("cuo.vm")
      .windows.some((w) => w.name === "Browser Test"),
  );
  await page
    .getByRole("button", { name: "Neues Wartungsfenster erstellen" })
    .click();
  await dialog.getByLabel("Name", { exact: true }).fill("Overlap draft");
  await dialog.getByLabel("Startzeit").fill("03:15");
  await dialog.getByRole("button", { name: "Fenster speichern" }).click();
  await page
    .locator("x-cuo-toasts x-toast[type=error]")
    .getByRole("alert")
    .waitFor({ state: "visible" });
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Overlap draft",
  );
  assert.equal(await dialog.getByLabel("Startzeit").inputValue(), "03:15");
  await page.keyboard.press("Escape");
  // Missing CSRF and mismatched Origin are rejected before dispatch.
  const missing = await context.request.post(origin + "/api/v1/scans", {
    headers: { Origin: origin, "Idempotency-Key": randomUUID() },
    data: {},
  });
  assert.equal(missing.status(), 403);
  const session = await (
    await context.request.get(origin + "/auth/session")
  ).json();
  const wrong = await context.request.post(origin + "/api/v1/scans", {
    headers: {
      Origin: "https://evil.invalid",
      "X-CSRF-Token": session.csrf,
      "Idempotency-Key": randomUUID(),
    },
    data: {},
  });
  assert.equal(wrong.status(), 403);
  const viewer = "Test Viewer " + randomUUID().slice(0, 6),
    vp = randomUUID() + "#";
  await context.request
    .post(origin + "/auth/users", {
      headers: {
        Origin: origin,
        "X-CSRF-Token": session.csrf,
        "Idempotency-Key": randomUUID(),
      },
      data: { name: viewer, password: vp, role: "Viewer" },
    })
    .then(async (r) => assert.equal(r.status(), 201, await r.text()));
  const viewContext = await browser.newContext();
  const login = await viewContext.request.post(origin + "/auth/login", {
    headers: { Origin: origin },
    data: { name: viewer, password: vp },
  });
  assert.equal(login.status(), 200);
  const vs = await (
    await viewContext.request.get(origin + "/auth/session")
  ).json();
  const denied = await viewContext.request.post(origin + "/api/v1/scans", {
    headers: {
      Origin: origin,
      "X-CSRF-Token": vs.csrf,
      "Idempotency-Key": randomUUID(),
    },
    data: {},
  });
  assert.equal(denied.status(), 403);
  const staticSource = await viewContext.request.get(
    origin + "/server/index.mjs",
  );
  assert.equal(staticSource.status(), 404);
  await viewContext.close();
  const anonymous = await browser.newContext();
  assert.equal(
    (await anonymous.request.get(origin + "/api/v1/containers")).status(),
    401,
  );
  await anonymous.close();
  await page.screenshot({ path: out + "/live.png", fullPage: true });
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    out + "/result.json",
    JSON.stringify(
      {
        ok: true,
        checks: [
          "RMT navigation",
          "filters",
          "native dialog keyboard",
          "dark mode",
          "mobile overflow and menu",
          "text-only XSS",
          "real enrollment and Docker inventory",
          "maintenance persistence",
          "CSRF",
          "Origin",
          "RBAC",
          "static allowlist",
          "anonymous rejection",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log("Browser integration passed.");
} finally {
  await browser.close();
}
