import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Auth } from "../server/auth.mjs";
import {
  preferenceDefaults,
  preferredLanguage,
  palettes,
} from "../shared/ui-preferences.mjs";
import { setLocale, t, xtendI18n, labelKey } from "../i18n/index.mjs";
import { messages } from "../i18n/catalog.mjs";

test("old profiles inherit defaults without a write and older clients preserve new preferences", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-appearance-"));
  let auth = new Auth(dir);
  try {
    const user = await auth.create(
      { name: "preferences-user", password: "long-preferences-password" },
      true,
    );
    const original = JSON.stringify({
      displayName: "Einstellungen",
      avatar: "cloud",
      theme: "system",
      updateNotifications: false,
    });
    auth.db
      .prepare("INSERT OR REPLACE INTO profiles VALUES(?,?)")
      .run(user.id, original);
    assert.deepEqual(auth.profile(user), {
      ...JSON.parse(original),
      ...preferenceDefaults,
    });
    assert.equal(
      auth.db.prepare("SELECT data FROM profiles WHERE user=?").get(user.id)
        .data,
      original,
    );
    const selected = auth.saveProfile(user, {
      palette: "wine",
      highContrast: true,
      language: "en",
      languageAutomatic: false,
    });
    assert.equal(selected.language, "en");
    for (const invalid of [
      { palette: "remote-theme" },
      { highContrast: "true" },
      { language: "fr" },
      { languageAutomatic: "false" },
    ])
      assert.throws(() => auth.saveProfile(user, invalid));
    auth.saveProfile(user, {
      displayName: "Original name",
      avatar: "initials",
      theme: "dark",
      updateNotifications: true,
      role: "Viewer",
    });
    auth.db.close();
    auth = new Auth(dir);
    const restored = auth.profile(user);
    assert.equal(restored.palette, "wine");
    assert.equal(restored.highContrast, true);
    assert.equal(restored.languageAutomatic, false);
    assert.equal(restored.language, "en");
    assert.equal(
      auth.db.prepare("SELECT role FROM users WHERE id=?").get(user.id).role,
      "Owner",
    );
  } finally {
    auth.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("browser language matching is deterministic with English fallback", () => {
  assert.equal(preferredLanguage(["de-AT", "en-GB"]), "de");
  assert.equal(preferredLanguage(["EN_us", "de"]), "en");
  assert.equal(preferredLanguage(["fr-FR", "de-CH"]), "de");
  assert.equal(preferredLanguage(["fr-FR", "ja"]), "en");
  assert.equal(preferredLanguage([]), "en");
  assert.deepEqual(palettes, ["slate", "black", "green", "wine"]);
});

test("native XTend catalogs have unique keys, matching placeholders and safe literal interpolation", async () => {
  const keys = Object.keys(messages).map(labelKey);
  assert.equal(new Set(keys).size, keys.length);
  for (const [de, en] of Object.entries(messages))
    assert.deepEqual(
      (de.match(/\{\w+\}/g) || []).sort(),
      (en.match(/\{\w+\}/g) || []).sort(),
      de,
    );
  await setLocale("en");
  assert.equal(t("Einstellungen"), "Settings");
  assert.equal(xtendI18n.getLocale(), "en");
  assert.equal(t("Container <user-value>"), "Container <user-value>");
  assert.equal(
    t("{v0} running containers", { v0: "<img src=x>" }),
    "<img src=x> running containers",
  );
  await setLocale("de");
  assert.equal(t("Einstellungen"), "Einstellungen");
  assert.ok(xtendI18n.snapshot().loadedLocales.includes("en"));
});

test("workspace tabs emit RMT intents and preserve names while localizing UI labels", async () => {
  const { JSDOM } = await import("../.framework/node_modules/jsdom/lib/api.js");
  const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
  for (const key of [
    "window",
    "document",
    "HTMLElement",
    "customElements",
    "CustomEvent",
    "AbortController",
    "MutationObserver",
    "FormData",
  ])
    globalThis[key] = dom.window[key];
  globalThis.fetch = async () => ({ ok: false });
  dom.window.HTMLElement.prototype.attachInternals = undefined;
  await import("../components/dialogs.mjs");
  await setLocale("en");
  const widget = document.createElement("x-cuo-workspace");
  widget.setAttribute("section", "settings");
  document.body.append(widget);
  const vm = {
    theme: "light",
    themeMode: "system",
    palette: "slate",
    highContrast: false,
    language: "de",
    languageAutomatic: true,
    locale: "en",
    settingsTab: "language",
    user: { name: "Einstellungen", role: "Owner" },
  };
  widget.vm = vm;
  assert.equal(widget.shadowRoot.querySelectorAll('[role="tab"]').length, 4);
  const selected = widget.shadowRoot.querySelector('[aria-selected="true"]');
  assert.equal(selected.textContent, "Language");
  assert.equal(
    widget.shadowRoot.querySelector("[data-auto-language]").checked,
    true,
  );
  assert.equal(
    widget.shadowRoot.querySelector("[data-language]").disabled,
    true,
  );
  let intent;
  widget.addEventListener("xtend-command", (e) => (intent = e.detail));
  selected.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }),
  );
  assert.equal(intent.kind, "settingsTab");
  assert.equal(intent.value, "data");
  widget.vm = { ...vm, settingsTab: "data" };
  assert.match(widget.shadowRoot.textContent, /Einstellungen · Owner/);
  assert.equal(widget.shadowRoot.querySelector("script"), null);
  widget.vm = { ...vm, settingsTab: "appearance" };
  assert.equal(widget.shadowRoot.querySelectorAll("[data-palette]").length, 4);
  const draftRadio = widget.shadowRoot.querySelector(
    '[data-palette][value="green"]',
  );
  draftRadio.checked = true;
  widget.vm = { ...vm, settingsTab: "appearance" };
  assert.equal(
    widget.shadowRoot.querySelector('[data-palette][value="slate"]').checked,
    true,
  );
  assert.equal(
    widget.shadowRoot.querySelector('[data-palette][value="green"]').checked,
    false,
  );

  await setLocale("de");
  dom.window.close();
});
