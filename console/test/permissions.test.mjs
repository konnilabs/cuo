import test from "node:test";
import assert from "node:assert/strict";

test("Owner grant requires warning acknowledgement; administrators preserve grants without editing them", async () => {
  const { JSDOM } = await import("../.framework/node_modules/jsdom/lib/api.js");
  const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
  for (const name of [
    "window",
    "document",
    "HTMLElement",
    "customElements",
    "CustomEvent",
    "AbortController",
    "MutationObserver",
    "FormData",
  ])
    globalThis[name] = dom.window[name];
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  await import("../components/dialogs.mjs");
  const id = "a".repeat(64);
  const policy = {
    id,
    scope: "container",
    target: id,
    mode: "automatic",
    concurrency: 1,
    windowId: "",
    excluded: false,
  };
  const element = document.createElement("x-approval-dialog");
  document.body.append(element);
  element.vm = {
    dialog: "policy",
    selected: id,
    policies: [policy],
    containers: [],
    windows: [],
    user: { role: "Owner" },
  };
  const form = element.shadowRoot.querySelector("form");
  const commands = [];
  element.addEventListener("xtend-command", (event) =>
    commands.push(event.detail),
  );
  assert.match(form.textContent, /Host-Prozesse und Systeminformationen/);
  assert.match(form.textContent, /einschließlich automatischer Läufe/);
  form.elements.readOnlyHostMonitoring.checked = true;
  form.requestSubmit();
  assert.equal(commands.length, 0);
  assert.match(
    form.elements.permissionsConfirmed.validationMessage,
    /Warnhinweis/,
  );
  form.elements.permissionsConfirmed.checked = true;
  form.elements.permissionsConfirmed.dispatchEvent(
    new dom.window.Event("change", { bubbles: true }),
  );
  assert.equal(form.elements.permissionsConfirmed.validationMessage, "");
  form.requestSubmit();
  assert.equal(commands.length, 0);
  assert.match(
    form.elements.permissionReason.validationMessage,
    /Freigabegrund/,
  );
  form.elements.permissionReason.value = "Trusted monitoring workload";
  form.elements.permissionReason.dispatchEvent(
    new dom.window.Event("input", { bubbles: true }),
  );
  assert.equal(form.checkValidity(), true);
  form.requestSubmit();
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].data.permissions, {
    readOnlyHostMonitoring: true,
  });
  assert.equal(commands[0].data.permissionsConfirmed, true);
  assert.equal(
    commands[0].data.permissionReason,
    "Trusted monitoring workload",
  );
  const approved = {
    ...policy,
    permissions: { readOnlyHostMonitoring: true },
    permissionsConfirmed: true,
    permissionReason: "Owner-approved monitoring",
  };
  element.vm = {
    dialog: "policy",
    selected: id,
    policies: [approved],
    containers: [],
    windows: [],
    user: { role: "Administrator" },
  };
  const adminForm = element.shadowRoot.querySelector("form");
  assert.equal(adminForm.elements.readOnlyHostMonitoring.disabled, true);
  assert.equal(adminForm.elements.permissionReason.disabled, true);
  adminForm.requestSubmit();
  assert.deepEqual(commands.at(-1).data.permissions, approved.permissions);
  assert.equal(
    commands.at(-1).data.permissionReason,
    approved.permissionReason,
  );
  assert.equal(commands.at(-1).data.permissionsConfirmed, true);
  const keys = ["preserveSysAdmin", "preserveSysPtrace", "preserveDacReadSearch", "preserveHostPid"];
  element.vm = { ...element.vm, policies: [policy], user: { role: "Owner" } };
  const ownerForm = element.shadowRoot.querySelector("form");
  for (const key of keys) {
    assert.equal(ownerForm.elements[key].disabled, false);
    ownerForm.elements[key].checked = true;
  }
  ownerForm.elements.permissionReason.value = "Trusted monitoring image with existing rights";
  ownerForm.elements.permissionsConfirmed.checked = true;
  ownerForm.requestSubmit();
  const granted = { ...policy, ...commands.at(-1).data };
  for (const key of keys) assert.equal(granted.permissions[key], true);
  element.vm = {
    ...element.vm, policies: [granted], user: { role: "Administrator" },
    capabilities: ["execution.monitoring.grant"],
  };
  const immutable = element.shadowRoot.querySelector("form");
  for (const key of [...keys, "readOnlyHostMonitoring", "permissionReason", "permissionsConfirmed"])
    assert.equal(immutable.elements[key].disabled, true, key);
  // A modified DOM still cannot turn off protected permissions or their reason.
  for (const key of keys) immutable.elements[key].checked = false;
  immutable.elements.permissionReason.value = "tampered";
  immutable.requestSubmit();
  assert.deepEqual(commands.at(-1).data.permissions, granted.permissions);
  assert.equal(commands.at(-1).data.permissionReason, granted.permissionReason);
  element.vm = { ...element.vm, user: { role: "Owner" } };
  const revoke = element.shadowRoot.querySelector("form");
  for (const key of keys) revoke.elements[key].checked = false;
  revoke.elements.readOnlyHostMonitoring.checked = false;
  revoke.requestSubmit();
  assert.ok(Object.values(commands.at(-1).data.permissions).every((value) => !value));
  assert.equal(commands.at(-1).data.permissionReason, "");
  assert.equal(commands.at(-1).data.permissionsConfirmed, false);
  element.vm = { ...element.vm, policies: [policy] };
  const global = element.shadowRoot.querySelector("form");
  global.elements.scope.value = "global";
  global.elements.preserveSysAdmin.checked = true;
  global.elements.permissionsConfirmed.checked = true;
  global.elements.permissionReason.value = "Must not inherit";
  const before = commands.length;
  global.requestSubmit();
  assert.equal(commands.length, before);
  assert.match(global.elements.target.validationMessage, /Container-Richtlinie/);
  dom.window.close();
});
