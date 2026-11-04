import test from "node:test";
import assert from "node:assert/strict";

test("all native CUO modals use one accessible X dismissal and restore the trigger", async () => {
  const { JSDOM } = await import("../.framework/node_modules/jsdom/lib/api.js");
  const dom = new JSDOM("<!doctype html><button id='trigger'>Open</button>", { url: "http://localhost/" });
  for (const key of ["window", "document", "HTMLElement", "customElements", "CustomEvent", "AbortController", "MutationObserver", "FormData"])
    globalThis[key] = dom.window[key];
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  await import("../components/dialogs.mjs");
  await import("../components/processes.mjs");
  const trigger = document.querySelector("#trigger");
  const vm = { selected: "", user: { role: "Owner" }, containers: [], windows: [], policies: [], jobs: [], capabilities: [] };
  const modal = document.createElement("x-approval-dialog");
  document.body.append(modal);
  modal.noticesState = "ready";
  for (const kind of ["help", "container", "add", "windowDetails", "window", "policy", "exclude", "run", "approve", "cancel", "user"]) {
    trigger.focus();
    modal.vm = { ...vm, dialog: kind };
    await Promise.resolve();
    const close = modal.shadowRoot.querySelectorAll(".dialog-heading .dialog-close");
    assert.equal(close.length, 1, kind);
    assert.equal(close[0].getAttribute("aria-label"), "Dialog schließen");
    assert.equal(close[0].getAttribute("type"), "button");
    assert.equal(close[0].textContent, "");
    assert.equal(close[0].querySelector("x-icon").getAttribute("name"), "close");
    let command;
    modal.addEventListener("xtend-command", (e) => command = e.detail, { once: true });
    close[0].click();
    assert.equal(command.kind, "close");
    modal.vm = { ...vm, dialog: "" };
    await Promise.resolve();
    assert.equal(document.activeElement, trigger, kind);
  }
  const process = document.createElement("x-cuo-process-detail");
  document.body.append(process);
  trigger.focus();
  process.vm = { ...vm, dialog: "process" };
  await Promise.resolve();
  assert.equal(process.shadowRoot.querySelectorAll(".dialog-close").length, 1);
  process.vm = { ...vm, dialog: "" };
  await Promise.resolve();
  assert.equal(document.activeElement, trigger);
  dom.window.close();
});
