// Isolated real Core/BFF/RMT integration. No Docker socket or existing accounts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  process.env.CUO_PLAYWRIGHT_MODULE || "playwright"
);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-020-browser-"));
const consoleDir = fileURLToPath(new URL("..", import.meta.url));
const out =
  process.env.CUO_INTEGRATIONS_OUTPUT || "reports/integrations-browser";
fs.mkdirSync(out, { recursive: true });
const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
};
const port = async () => {
  const server = await listen(() => {});
  const p = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return p;
};
const agent = await listen((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(req.url === "/inventory" ? "[]" : "{}");
});
const registry = await listen((req, res) => {
  const expected =
    "Basic " + Buffer.from("fixture:browser-secret-only").toString("base64");
  if (req.headers.authorization !== expected) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(
    req.url.includes("_catalog")
      ? JSON.stringify({ repositories: ["universal/app"] })
      : req.url.includes("tags/list")
        ? JSON.stringify({ name: "universal/app", tags: ["stable"] })
        : "{}",
  );
});
const cp = await port(),
  bp = await port(),
  origin = `http://127.0.0.1:${bp}`,
  token = randomBytes(32).toString("hex"),
  key = path.join(directory, "key");
fs.writeFileSync(key, randomBytes(32).toString("base64"), { mode: 0o600 });
let logs = "";
const start = (command, args, env, cwd) => {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => (logs += data));
  child.stderr.on("data", (data) => (logs += data));
  return child;
};
const core = start(
  process.env.CUO_CORE_BINARY || path.resolve("../work/cuo-020-build/cuo"),
  [],
  {
    CUO_DATA: path.join(directory, "core"),
    CUO_LISTEN: `127.0.0.1:${cp}`,
    CUO_CORE_TOKEN: token,
    CUO_AGENT_URL: `http://127.0.0.1:${agent.address().port}`,
    CUO_AGENT_TOKEN: "fixture",
    CUO_INTEGRATION_KEY_FILE: key,
    CUO_ORIGIN: origin,
    CUO_ZOT_INTERNAL_URL: `http://127.0.0.1:${registry.address().port}`,
    CUO_ZOT_HOST: `127.0.0.1:${registry.address().port}`,
  },
);
const bff = start(
  process.execPath,
  ["server/index.mjs"],
  {
    CUO_AUTH_DATA: path.join(directory, "identity"),
    CUO_ORIGIN: origin,
    CUO_PORT: String(bp),
    CUO_BIND: "127.0.0.1",
    CUO_CORE_URL: `http://127.0.0.1:${cp}`,
    CUO_CORE_TOKEN: token,
  },
  consoleDir,
);
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + "/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CUO_CHROMIUM
      ? { executablePath: process.env.CUO_CHROMIUM }
      : {}),
  });
  const context = await browser.newContext({
    locale: "de-DE",
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const vm = () =>
    page.evaluate(() => window.XTendMaraca.model.getState("cuo.vm"));
  const ready = () =>
    page.waitForFunction(
      () => window.XTendMaraca?.model?.getState("cuo.vm")?.auth === "ready",
    );
  const go = async (route) => {
    await page.evaluate(
      (value) =>
        window.XTendMaraca.dispatchCommand("cuo.intent", {
          kind: "navigate",
          value,
        }),
      route,
    );
    await page.waitForFunction(
      (route) => location.hash === "#/" + route,
      route,
    );
  };
  await page.goto(origin);
  await page.getByLabel("Benutzername", { exact: true }).fill("fixture-owner");
  await page
    .getByLabel("Passwort", { exact: true })
    .fill("fixture-browser-password-020");
  await page
    .getByRole("button", { name: "Administrator anlegen", exact: true })
    .click();
  await ready();
  await go("registries");
  await page
    .getByRole("button", { name: "Registry verbinden", exact: true })
    .click();
  const form = page.locator("x-unioci-registry-settings form");
  await form
    .getByLabel("Name", { exact: true })
    .fill("Universelle Testregistry");
  await form
    .getByLabel("Kanonischer Registry-Host", { exact: true })
    .fill(`127.0.0.1:${registry.address().port}`);
  await form
    .getByLabel("API-Endpunkt", { exact: true })
    .fill(`http://127.0.0.1:${registry.address().port}`);
  await form.locator("[name=repositories]").fill("universal/*");
  await form.locator("[name=username]").fill("fixture");
  await form.locator("[name=password]").fill("browser-secret-only");
  await form.locator("details summary").click();
  await form.locator("[name=privateNetwork]").check();
  await form.locator("[name=reason]").fill("Isolierter Browser-Test");
  await form.locator("[name=confirmed]").check();
  await form.getByRole("button", { name: "Speichern", exact: true }).click();
  await page.waitForFunction(() =>
    window.XTendMaraca.model
      .getState("cuo.vm")
      .registries.some((r) => r.name === "Universelle Testregistry"),
  );
  const id = (await vm()).registries.find(
    (r) => r.name === "Universelle Testregistry",
  ).id;
  assert.equal(
    JSON.stringify(await vm()).includes("browser-secret-only"),
    false,
  );
  assert.equal(await form.locator("[name=password]").inputValue(), "");
  await go(`registries/${id}/repositories`);
  await page
    .getByRole("button", { name: "Repositories laden", exact: true })
    .click();
  await page.waitForFunction(() =>
    window.XTendMaraca.model
      .getState("cuo.vm")
      .registryRepositories.includes("universal/app"),
  );
  await page.reload();
  await ready();
  assert.equal((await vm()).registryId, id);
  await go("integrations/github");
  await page
    .locator("x-cuo-github-connection")
    .getByLabel("Name", { exact: true })
    .fill("Meine GitHub-App");
  await page
    .locator("x-cuo-github-connection [name=reason]")
    .fill("App vorbereiten");
  await page.locator("x-cuo-github-connection [name=confirmed]").check();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.XTendMaraca.model.getState("cuo.vm").githubConnections.length ===
      1,
  );
  await go("users/permissions");
  const matrix = page.locator("x-cuo-permission-matrix");
  const input = matrix.getByLabel(
    "Administrator: Images per Digest importieren",
    { exact: true },
  );
  await input.check();
  await matrix
    .locator("[name=reason]")
    .fill("Administratoren dürfen Importe anlegen");
  await matrix.locator("[name=confirmed]").check();
  await matrix
    .getByRole("button", { name: "Berechtigungen speichern", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      window.XTendMaraca.model.getState("cuo.vm").permissionMatrix.policy
        .revision === 2,
  );
  const response = await fetch(`http://127.0.0.1:${cp}/api/v1/permissions/me`, {
    headers: {
      Authorization: "Bearer " + token,
      "X-CUO-Actor": "fixture-admin",
      "X-CUO-Role": "Administrator",
      "X-CUO-Hosts": "local",
    },
  });
  assert.ok((await response.json()).capabilities.includes("registry.import"));
  if (process.env.CUO_AXE_MODULE) {
    const module = await import(process.env.CUO_AXE_MODULE);
    const AxeBuilder = module.AxeBuilder || module.default;
    const result = await new AxeBuilder({ page })
      .include("x-cuo-permission-matrix")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    fs.writeFileSync(
      path.join(out, "a11y-permissions.json"),
      JSON.stringify(result, null, 2),
    );
    assert.deepEqual(
      result.violations.map((v) => v.id),
      [],
    );
  }
  await page.screenshot({
    path: path.join(out, "permissions-light.png"),
    fullPage: true,
  });
  await page.evaluate(() =>
    window.XTendMaraca.dispatchCommand("cuo.intent", {
      kind: "themeSet",
      value: "true",
    }),
  );
  await page.screenshot({
    path: path.join(out, "permissions-dark.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const selector of [
    ".global-search input",
    "x-cuo-permission-matrix input[name=reason]",
  ])
    assert.ok(
      await page
        .locator(selector)
        .evaluate((n) => parseFloat(getComputedStyle(n).fontSize) >= 16),
    );
  const layout = await page.evaluate(() => {
    const values = [];
    function inspect(root) {
      for (const n of root.querySelectorAll("*")) {
        const r = n.getBoundingClientRect();
        if (r.width && r.right > innerWidth + 1)
          values.push({
            tag: n.tagName,
            cls: n.className,
            w: r.width,
            right: r.right,
            min: getComputedStyle(n).minWidth,
            display: getComputedStyle(n).display,
          });
        if (n.shadowRoot) inspect(n.shadowRoot);
      }
    }
    inspect(document);
    return {
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      values,
    };
  });
  fs.writeFileSync(
    path.join(out, "mobile-layout.json"),
    JSON.stringify(layout, null, 2),
  );
  await page.screenshot({
    path: path.join(out, "permissions-mobile.png"),
    fullPage: true,
  });
  assert.equal(layout.scroll <= layout.width, true);
  for (const route of [
    "registries",
    "subscriptions",
    "integrations/github",
    `integrations/github/${(await vm()).githubConnections[0].id}/deliveries`,
    "users/permissions",
  ]) {
    await go(route);
    await page.reload();
    await ready();
    assert.equal((await vm()).routePath, "/" + route);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.locator("x-cuo-permission-matrix form").count(), 1);
  const before = await page.evaluate(
    () => window.XTendMaraca.model.getState("cuo.vm").page,
  );
  const soakCommands = Math.min(
    1000,
    Math.max(1, Number(process.env.CUO_SOAK_COMMANDS || 1000)),
  );
  for (let i = 0; i < soakCommands; i++)
    await page.evaluate(() =>
      window.XTendMaraca.dispatchCommand("cuo.intent", {
        kind: "integrationCloseArtifact",
      }),
    );
  assert.equal((await vm()).page, before);
  assert.equal(await page.locator("x-cuo-permission-matrix form").count(), 1);
  assert.deepEqual(errors, []);
  const report = {
    schema: "cuo.integrations-browser.v1",
    createdAt: new Date().toISOString(),
    passed: true,
    checks: [
      "real Core/BFF/RMT enrollment",
      "private registry credentials excluded from model",
      "new and nested route reloads",
      "repository query through authenticated UniOCI",
      "GitHub connection draft",
      "permission matrix saved and enforced by Core",
      "light/dark/mobile screenshots",
      `${soakCommands} commands remain usable`,
      "mobile native inputs are at least 16px to mitigate iOS focus zoom",
      "no uncaught browser errors",
    ],
  };
  fs.writeFileSync(
    path.join(out, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fs.writeFileSync(path.join(out, "failure.log"), logs);
  throw error;
} finally {
  await browser?.close();
  bff.kill();
  core.kill();
  await Promise.all([
    new Promise((r) => agent.close(r)),
    new Promise((r) => registry.close(r)),
  ]);
  fs.rmSync(directory, { recursive: true, force: true });
}
