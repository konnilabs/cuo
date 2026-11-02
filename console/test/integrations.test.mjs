import test from "node:test";
import assert from "node:assert/strict";

test("Integration forms emit one-use handles; passwords never enter RMT commands", async () => {
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
  await import("../components/integrations.mjs");
  const element = document.createElement("x-unioci-registry-settings");
  document.body.append(element);
  element.vm = {
    user: { role: "Owner" },
    capabilities: [],
    registries: [],
    registryId: "new",
    registryEditor: "new",
    theme: "light",
  };
  const commands = [];
  element.addEventListener("xtend-command", (e) => commands.push(e.detail));
  const form = element.shadowRoot.querySelector("form");
  for (const [name, value] of Object.entries({
    name: "Private",
    host: "registry.example.com",
    endpoint: "https://registry.example.com",
    repositories: "team/*",
    username: "pull",
    password: "never-in-rmt-password",
    reason: "Unit test",
  }))
    form.elements.namedItem(name).value = value;
  form.elements.namedItem("confirmed").checked = true;
  element.submit(form);
  assert.equal(commands.length, 1);
  assert.equal(
    JSON.stringify(commands).includes("never-in-rmt-password"),
    false,
  );
  const data = commands[0].data;
  const handle = data.submission;
  const payload = element.takeSubmission(handle);
  assert.equal(payload.values.password, "never-in-rmt-password");
  assert.equal(form.elements.namedItem("password").value, "");
  assert.throws(() => element.takeSubmission(handle));
  element.remove();
  assert.equal(element.submissions.size, 0);
});

test("Nested RMT routes preserve stable IDs and reject malformed routes", async () => {
  const { routeDetails } = await import("../src/integrations.ts");
  const id = "a".repeat(32);
  assert.equal(
    routeDetails(`/registries/${id}/repositories`).page,
    "repositories",
  );
  assert.equal(routeDetails(`/registries/${id}/repositories`).registryId, id);
  assert.equal(routeDetails("/users/permissions").page, "permissions");
  assert.equal(
    routeDetails(`/integrations/github/${id}/deliveries`).githubId,
    id,
  );
  assert.notEqual(routeDetails("/registries/../../api").page, "registry");
});

test("Explicit numeric form revisions cannot collide with positional sibling keys", async () => {
  const { JSDOM } = await import("../.framework/node_modules/jsdom/lib/api.js");
  const dom = new JSDOM("<!doctype html>");
  globalThis.document = dom.window.document;
  const { patch, h } = await import("../components/base.mjs");
  const root = document.createElement("div");
  for (const revision of [1, 1, 2, 2, 3, 3, 1, 2]) {
    patch(root, [
      h("header", {}, "Heading"),
      h("p", {}, "Note"),
      h("form", { key: revision }, h("input", { name: "reason" })),
    ]);
    assert.equal(root.childNodes.length, 3);
    assert.equal(root.querySelectorAll("form").length, 1);
    assert.equal(root.querySelectorAll("p").length, 1);
  }
});
