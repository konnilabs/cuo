// Self-contained browser integration: real CUO BFF/SQLite and a signed OIDC fixture.
// The Core fixture supplies deterministic notifications; no host containers mutate.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { provider } from "./oidc-provider.mjs";
const { chromium } = await import(
  process.env.CUO_PLAYWRIGHT_MODULE || "playwright"
);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-browser-auth-"));
const out = process.env.CUO_EXTENSIONS_OUTPUT || "reports/extensions-browser";
fs.mkdirSync(out, { recursive: true });
const p = await provider({ hostname: "localhost" });
let digest = "a".repeat(64);
const core = http.createServer((req, res) => {
  if (req.url.startsWith("/api/v1/events")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": fixture\n\n");
    return;
  }
  if (req.url.startsWith("/api/v1/permissions/me")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        capabilities: ["inventory.read", "registry.read"],
        revision: 1,
      }),
    );
    return;
  }
  let items = [];
  if (req.url.startsWith("/api/v1/containers"))
    items = [
      {
        id: "fixture-container",
        name: "web-service",
        image: "example/app:stable",
        imageId: "sha256:old",
        managed: true,
        excluded: false,
        state: "running",
        platform: "linux/amd64",
        group: "Standard",
        mode: "scan-only",
        candidate: {
          targetDigest: "sha256:" + digest,
          sourceDigest: "sha256:old",
        },
      },
    ];
  if (req.url.startsWith("/api/v1/hosts"))
    items = [{ id: "local", name: "Local Docker", connected: true }];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ items }));
});
await new Promise((resolve) => core.listen(0, "127.0.0.1", resolve));
const portProbe = http.createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server/index.mjs"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    ...process.env,
    CUO_AUTH_DATA: directory,
    CUO_ORIGIN: origin,
    CUO_PORT: String(port),
    CUO_BIND: "127.0.0.1",
    CUO_CORE_URL: `http://127.0.0.1:${core.address().port}`,
    CUO_CORE_TOKEN: "test-only",
    CUO_OIDC_ALLOW_HTTP: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverErrors = "";
server.stderr.on("data", (b) => (serverErrors += b));
let browser;
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
      reducedMotion: "reduce",
      colorScheme: "light",
    }),
    page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  const model = () =>
    page.evaluate(() => window.XTendMaraca.model.getState("cuo.vm"));
  const wait = async (expression, arg) => page.waitForFunction(expression, arg);
  const ready = () =>
    wait(() => window.XTendMaraca?.model?.getState("cuo.vm")?.auth === "ready");
  await page.goto(origin);
  await wait(
    () => window.XTendMaraca?.model?.getState("cuo.vm")?.auth === "enroll",
  );
  const auth = page.locator("x-cuo-auth");
  await auth.getByLabel("Benutzername").fill("fixture-owner");
  await auth
    .getByLabel("Passwort", { exact: true })
    .fill("fixture-long-password-42");
  await auth.getByRole("button", { name: "Administrator anlegen" }).click();
  await ready();
  assert.equal((await model()).user.role, "Owner");
  console.log("Enrollment passed.");
  // Actual XRouter: URL, browser history and reload retain the route.
  await page.getByRole("button", { name: "Container", exact: true }).click();
  await wait(() => location.hash === "#/containers");
  await page
    .getByRole("button", { name: "Einstellungen", exact: true })
    .click();
  await wait(() => location.hash === "#/settings");
  await page.goBack();
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").page === "containers",
  );
  await page.goForward();
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").page === "settings",
  );
  await page.reload();
  await ready();
  assert.equal((await model()).page, "settings");
  assert.equal(
    await page.locator("x-router").evaluate((n) => n.snapshot().current.path),
    "/settings",
  );
  console.log("Router passed.");
  // Native XTend toggle and OS preference updates through the RMT command.
  const settings = page.locator("x-cuo-workspace[section=settings]");
  assert.equal(
    await settings
      .locator("x-toggle")
      .evaluate((n) => n.constructor.xtendComponentContract.tag),
    "x-toggle",
  );
  await settings.getByLabel("Automatisch", { exact: true }).uncheck();
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").themeMode === "light",
  );
  await settings.locator("x-toggle").locator("[part=track]").click();
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").theme === "dark",
  );
  await settings.getByLabel("Automatisch", { exact: true }).check();
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").themeMode === "system",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").theme === "dark",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").theme === "light",
  );
  console.log("Appearance passed.");
  // Notification dismissal survives a reload and a new image produces a new item.
  await page
    .getByRole("button", { name: "Benachrichtigungen", exact: true })
    .click();
  const center = page.locator("x-cuo-notifications");
  await center
    .getByRole("button", { name: /Benachrichtigung schließen: web-service/ })
    .click();
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").notificationCount === "0",
  );
  await page.reload();
  await ready();
  assert.equal((await model()).notificationCount, "0");
  digest = "b".repeat(64);
  await page.evaluate(() =>
    window.XTendMaraca.dispatchCommand("cuo.intent", { kind: "refresh" }),
  );
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").notificationCount === "1",
  );
  await page
    .getByRole("button", { name: "Benachrichtigungen", exact: true })
    .click();
  await center
    .getByRole("region", { name: "Benachrichtigungen", exact: true })
    .waitFor({ state: "visible" });
  await page.screenshot({ path: out + "/notifications.png", fullPage: true });
  await center
    .getByRole("button", { name: "Alle löschen", exact: true })
    .click();
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").notificationCount === "0",
  );
  await page.keyboard.press("Escape");
  await wait(
    () => !window.XTendMaraca.model.getState("cuo.vm").notificationsOpen,
  );
  console.log("Notifications passed.");
  // Profile uses the real drawer, with saved name/icon and keyboard close.
  await page
    .getByRole("button", { name: "Dein Profil öffnen", exact: true })
    .click();
  const drawer = page.locator("x-cuo-profile");
  await drawer
    .getByRole("dialog", { name: "Dein Profil", exact: true })
    .waitFor({ state: "visible" });
  await drawer.getByLabel("Anzeigename", { exact: true }).fill("Mein Profil");
  await drawer.getByLabel("Profil-Icon", { exact: true }).selectOption("cloud");
  await drawer
    .getByRole("button", { name: "Profil speichern", exact: true })
    .click();
  await wait(
    () =>
      window.XTendMaraca.model.getState("cuo.vm").user.name === "Mein Profil",
  );
  assert.equal(
    await drawer.locator("x-drawer").evaluate((n) => n.snapshot().componentRef),
    "x-drawer",
  );
  const toastLayer = page.locator("x-cuo-toasts"),
    profileToast = toastLayer
      .locator("x-toast")
      .filter({ hasText: "Profil gespeichert." });
  await profileToast.getByRole("status").waitFor({ state: "visible" });
  assert.equal(
    await toastLayer.evaluate((n) => n.matches(":popover-open")),
    true,
  );
  assert.equal(
    await toastLayer.evaluate((n) => getComputedStyle(n).zIndex),
    "2147483647",
  );
  assert.equal(
    await profileToast.evaluate(
      (n) => n.constructor.xtendComponentContract.tag,
    ),
    "x-toast",
  );
  assert.equal(
    await toastLayer.evaluate((n) => {
      const r = n.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + 24) === n;
    }),
    true,
  );
  assert.equal(
    await toastLayer.evaluate((n) => {
      const rect = n.getBoundingClientRect();
      return (
        Math.abs(innerHeight - rect.bottom - 16) <= 2 &&
        Math.abs(innerWidth - rect.right - 16) <= 2
      );
    }),
    true,
  );
  assert.equal(await drawer.locator(".callout,.form-error").count(), 0);
  assert.equal(await page.locator(".main-content>.notice").count(), 0);
  await page.screenshot({
    path: out + "/profile-toast-front.png",
    fullPage: true,
  });
  await profileToast
    .getByRole("button", { name: "Schliessen", exact: true })
    .click();
  await wait(
    () =>
      !window.XTendMaraca.model
        .getState("cuo.vm")
        .toasts.some((t) => t.message === "Profil gespeichert."),
  );
  assert.equal((await model()).profileOpen, true);
  await drawer
    .getByRole("button", { name: "Profil speichern", exact: true })
    .click();
  await profileToast.getByRole("status").waitFor({ state: "visible" });
  await profileToast.waitFor({ state: "detached", timeout: 10000 });
  await page.screenshot({ path: out + "/profile.png", fullPage: true });
  await page.keyboard.press("Escape");
  await wait(() => !window.XTendMaraca.model.getState("cuo.vm").profileOpen);
  await page.reload();
  await ready();
  assert.equal((await model()).user.name, "Mein Profil");
  assert.equal((await model()).user.profile.avatar, "cloud");
  console.log("Profile passed.");
  // Configure a provider entirely through the product UI and use SSO end to end.
  await page
    .getByRole("button", { name: "Integrationen", exact: true })
    .click();
  const integration = page.locator("x-cuo-workspace[section=integrations]");
  assert.equal(
    await integration.getByLabel("Redirect-URI", { exact: true }).inputValue(),
    origin + "/auth/oidc/callback",
  );
  await integration
    .getByLabel("SSO-Anmeldung aktivieren", { exact: true })
    .check();
  await integration.getByLabel("Issuer-URL", { exact: true }).fill(p.issuer);
  await integration
    .getByLabel("Discovery-URL (optional)", { exact: true })
    .fill(p.issuer + "/openid-configuration");
  await integration
    .getByLabel("Client-ID", { exact: true })
    .fill("fixture-client");
  await integration.locator("input[name=clientSecret]").fill("fixture-secret");
  await integration
    .getByRole("button", {
      name: "Speichern und Verbindung prüfen",
      exact: true,
    })
    .click();
  await wait(
    () => window.XTendMaraca.model.getState("cuo.vm").oidc.enabled === true,
  );
  await page.screenshot({ path: out + "/oidc.png", fullPage: true });
  const csrf = (
    await (await context.request.get(origin + "/auth/session")).json()
  ).csrf;
  const config = await (
    await context.request.get(origin + "/auth/oidc/config")
  ).json();
  assert.equal("clientSecret" in config, false);
  assert.equal(config.secretConfigured, true);
  await context.request.post(origin + "/auth/logout", {
    headers: { Origin: origin, "X-CSRF-Token": csrf },
    data: {},
  });
  await page.goto(origin);
  await auth
    .getByRole("button", { name: "Mit SSO anmelden", exact: true })
    .click();
  await ready();
  assert.equal((await model()).user.name, "Federated Test User");
  assert.equal((await model()).user.role, "Viewer");
  assert.equal((await model()).notificationCount, "1");
  assert.equal(
    (await context.request.get(origin + "/auth/oidc/config")).status(),
    403,
  );
  await page.screenshot({ path: out + "/sso-user.png", fullPage: true });
  assert.deepEqual(errors, []);
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(origin);
  await mobile.waitForFunction(
    () => window.XTendMaraca?.model?.getState("cuo.vm")?.auth === "ready",
  );
  await mobile
    .getByRole("button", { name: "Dein Profil öffnen", exact: true })
    .click();
  await mobile
    .getByRole("dialog", { name: "Dein Profil", exact: true })
    .waitFor({ state: "visible" });
  await mobile.screenshot({
    path: out + "/profile-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await mobile.keyboard.press("Escape");
  const logs = await context.newPage();
  await logs.setViewportSize({ width: 1122, height: 892 });
  await logs.goto(origin + "/?demo=1#/logs");
  await logs.waitForFunction(
    () =>
      window.XTendMaraca?.model?.getState("cuo.vm")?.demo &&
      window.XTendMaraca.model.getState("cuo.vm").page === "logs",
  );
  const terminal = logs.locator("x-log-stream[expanded]").getByRole("log"),
    card = logs.locator(".logs-workspace");
  const screenRect = await terminal.boundingBox(),
    cardRect = await card.boundingBox();
  assert.ok(screenRect.height >= 350, JSON.stringify({ screenRect, cardRect }));
  assert.ok(
    cardRect.y + cardRect.height - screenRect.y - screenRect.height <= 26,
    JSON.stringify({ screenRect, cardRect }),
  );
  await logs.screenshot({ path: out + "/logs-filled.png", fullPage: true });
  await logs.close();
  const local = await browser.newContext();
  assert.equal(
    (
      await local.request.post(origin + "/auth/login", {
        headers: { Origin: origin },
        data: { name: "fixture-owner", password: "fixture-long-password-42" },
      })
    ).status(),
    200,
  );
  assert.equal(
    (await (await local.request.get(origin + "/auth/session")).json()).user
      .name,
    "Mein Profil",
  );
  await local.close();
  fs.writeFileSync(
    out + "/verification.json",
    JSON.stringify(
      {
        passed: true,
        checks: [
          "XRouter URL/back/forward/reload",
          "XToggle and live OS theme",
          "durable individual/clear-all notifications",
          "XDrawer profile and persistence",
          "owner-only OIDC configuration and redirect URI",
          "cross-site signed OIDC browser flow with PKCE and explicit discovery URL",
          "provider user provisioned as Viewer",
          "mobile drawer",
          "logs terminal fills card at 1122x892 viewport",
          "real XToast in top layer above active drawer; pointer dismissal and timeout",
        ],
        browserErrors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("CUO extension browser checks passed.");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((resolve) => {
    server.once("exit", resolve);
    setTimeout(() => {
      server.kill("SIGKILL");
      resolve();
    }, 2000).unref();
  });
  core.closeAllConnections();
  await new Promise((resolve) => core.close(resolve));
  await p.close();
  fs.rmSync(directory, { recursive: true, force: true });
  if (serverErrors) console.error(serverErrors);
}
