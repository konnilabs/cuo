// Real RMT/BFF assets; browser-only session fixtures never mutate user accounts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.CUO_PLAYWRIGHT_MODULE || "playwright");
const out = process.env.CUO_AUTH_APPEARANCE_OUTPUT || "reports/auth-appearance-browser";
fs.mkdirSync(out, { recursive: true });
let origin = process.env.CUO_AUTH_APPEARANCE_ORIGIN;
let server, directory, browser, stderr = "";
const samples = [], errors = [];
const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => v / 255);
const luminance = (value) => rgb(value).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
const surface = { slate: "rgb(26, 38, 58)", black: "rgb(23, 23, 23)", green: "rgb(16, 44, 32)", wine: "rgb(52, 26, 38)" };
try {
  if (!origin) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-auth-appearance-"));
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    origin = "http://127.0.0.1:" + port;
    server = spawn(process.execPath, ["server/index.mjs"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, CUO_AUTH_DATA: directory, CUO_ORIGIN: origin, CUO_BIND: "127.0.0.1", CUO_PORT: String(port), CUO_CORE_URL: "http://127.0.0.1:1", CUO_CORE_TOKEN: "auth-appearance-test-only" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    server.stderr.on("data", (value) => stderr += value);
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(origin + "/health")).ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal((await (await fetch(origin + "/health")).json()).version, "0.3.1");
  browser = await chromium.launch({ headless: true, ...(process.env.CUO_CHROMIUM ? { executablePath: process.env.CUO_CHROMIUM } : {}) });
  const anonymous = ["light", "dark"].flatMap((system) => [320, 1280].flatMap((width) => ["login", "enroll", "sso"].map((kind) => ({ system, width, kind }))));
  const profiles = ["slate", "black", "green", "wine"].flatMap((palette) => ["light", "dark"].map((theme) => ({ system: theme === "dark" ? "light" : "dark", width: 1280, kind: "profile", palette, theme })));
  const cases = process.env.CUO_AUTH_APPEARANCE_SMOKE === "1" ? anonymous.filter((c) => c.width === 1280 && c.kind === "login") : [...anonymous, ...profiles];
  for (const config of cases) {
    const { system, width, kind, palette = "slate", theme = system } = config;
    const context = await browser.newContext({ colorScheme: system, locale: "de-DE", viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => errors.push(error.message));
    let releaseBoot, releaseSession;
    const bootGate = new Promise((resolve) => releaseBoot = resolve);
    const sessionGate = new Promise((resolve) => releaseSession = resolve);
    const session = {
      enrollment: kind === "enroll", csrf: "test-only",
      user: kind === "profile" ? { id: "fixture", name: "Theme fixture", role: "Viewer", hosts: ["local"], profile: { displayName: "Theme fixture", avatar: "initials", theme, palette, highContrast: false, language: "de", languageAutomatic: false, updateNotifications: true } } : null,
      oidc: { enabled: kind === "sso", localLoginEnabled: kind !== "sso", label: "Mit SSO anmelden" },
    };
    await page.route("**/boot.mjs", async (route) => { await bootGate; await route.continue(); });
    await page.route("**/auth/session", async (route) => { await sessionGate; await route.fulfill({ json: session }); });
    await page.route("**/api/v1/**", async (route) => {
      assert.equal(route.request().method(), "GET", "theme fixtures must remain read-only");
      if (new URL(route.request().url()).pathname === "/api/v1/events")
        return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
      return route.fulfill({ json: { items: [], capabilities: ["inventory.read"], revision: 1 } });
    });
    try {
      await page.goto(origin, { waitUntil: "commit" });
      await page.waitForFunction(() => !!document.querySelector("link[data-maraca-style]")?.sheet);
      const beforeBoot = await page.evaluate(() => ({ background: getComputedStyle(document.documentElement).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme }));
      assert.equal(beforeBoot.scheme, system, "system preference applies before JavaScript boots");
      assert.equal(beforeBoot.background, system === "dark" ? "rgb(16, 25, 42)" : "rgb(246, 249, 254)");
      releaseBoot();
      await page.locator("x-cuo-auth .auth-card").waitFor();
      await page.waitForFunction(() => !!document.querySelector("x-cuo-auth")?.shadowRoot.querySelector("link")?.sheet);
      assert.equal(await page.evaluate(() => window.XTendMaraca.model.getState("cuo.vm").auth), "loading");
      const inspect = () => page.locator("x-cuo-auth").evaluate((widget) => {
        const card = widget.shadowRoot.querySelector(".auth-card"), r = card.getBoundingClientRect();
        return {
          background: getComputedStyle(card).backgroundColor, text: getComputedStyle(card).color,
          footer: getComputedStyle(widget.shadowRoot.querySelector(".auth-footer")).color,
          eyebrow: getComputedStyle(widget.shadowRoot.querySelector(".eyebrow")).color,
          fields: [...widget.shadowRoot.querySelectorAll("input")].map((input) => ({ background: getComputedStyle(input).backgroundColor, text: getComputedStyle(input).color, fontSize: parseFloat(getComputedStyle(input).fontSize) })),
          scheme: getComputedStyle(document.documentElement).colorScheme,
          backdrop: getComputedStyle(document.querySelector(".auth-wrap")).backgroundImage,
          fits: document.documentElement.scrollWidth <= innerWidth && r.left >= 0 && r.right <= innerWidth,
        };
      });
      const loading = await inspect();
      assert.equal(loading.background, system === "dark" ? surface.slate : "rgb(255, 255, 255)");
      assert.ok(contrast(loading.text, loading.background) >= 4.5);
      assert.ok(loading.fits);
      if (kind === "login" && width === 1280) await page.screenshot({ path: path.join(out, `loading-${system}.png`) });
      releaseSession();
      await page.waitForFunction((kind) => window.XTendMaraca.model.getState("cuo.vm").auth === (kind === "profile" ? "ready" : kind === "enroll" ? "enroll" : "login"), kind);
      if (kind === "profile") {
        const result = await page.evaluate(() => ({ theme: window.XTendMaraca.model.getState("cuo.vm").theme, palette: window.XTendMaraca.model.getState("cuo.vm").palette, surface: getComputedStyle(document.documentElement).getPropertyValue("--cuo-surface").trim(), scheme: getComputedStyle(document.documentElement).colorScheme }));
        assert.equal(result.theme, theme); assert.equal(result.palette, palette); assert.equal(result.scheme, theme);
        assert.equal(result.surface, theme === "light" ? "#ffffff" : { slate: "#1a263a", black: "#171717", green: "#102c20", wine: "#341a26" }[palette]);
        assert.equal(await page.locator(".auth-wrap").isVisible(), false);
        samples.push({ ...config, beforeBoot, loading, profile: result });
      } else {
        const login = await inspect();
        assert.equal(login.background, system === "dark" ? surface.slate : "rgb(255, 255, 255)");
        assert.equal(login.scheme, system);
        for (const foreground of [login.text, login.footer, login.eyebrow]) assert.ok(contrast(foreground, login.background) >= 4.5, JSON.stringify(login));
        assert.equal(login.fields.length, kind === "sso" ? 0 : 2);
        for (const input of login.fields) {
          assert.equal(input.background, login.background);
          assert.ok(contrast(input.text, input.background) >= 4.5);
          if (width === 320) assert.ok(input.fontSize >= 16, "mobile auth inputs must not trigger focus zoom");
        }
        assert.equal(await page.locator('x-cuo-auth [data-kind="oidcLogin"]').count(), kind === "sso" ? 1 : 0);
        assert.ok(login.fits);
        if (width === 320 || kind === "login") await page.screenshot({ path: path.join(out, `${kind}-${system}-${width}.png`) });
        const next = system === "dark" ? "light" : "dark";
        await page.emulateMedia({ colorScheme: next });
        await page.waitForFunction((next) => window.XTendMaraca.model.getState("cuo.vm").theme === next, next);
        const changed = await inspect();
        assert.equal(changed.background, next === "dark" ? surface.slate : "rgb(255, 255, 255)");
        samples.push({ ...config, beforeBoot, loading, login, systemChange: changed });
      }
    } catch (error) {
      await page.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
      throw error;
    } finally { releaseBoot(); releaseSession(); await context.close(); }
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ version: "0.3.1", verifiedAt: new Date().toISOString(), samples, errors }, null, 2) + "\n");
  console.log(`${samples.length} auth appearance cases passed: pre-boot/loading, login, enrollment, SSO-only, system changes, mobile and explicit profile palettes.`);
} catch (error) {
  fs.writeFileSync(path.join(out, "server-errors.log"), stderr);
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) try { await page.screenshot({ path: path.join(out, "failure.png") }); } catch {}
  throw error;
} finally {
  await browser?.close();
  if (server) { server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
}
