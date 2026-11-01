import "./icons.mjs";
export const h = (tag, attrs = {}, ...children) => ({
  tag,
  attrs,
  children: children
    .flat(Infinity)
    .filter((v) => v !== null && v !== undefined && v !== false),
});
export function icon(name, pack = "core") {
  return h("x-icon", { name, pack, size: "19px", decorative: true });
}
export function button(
  label,
  kind,
  value = "",
  id = "",
  className = "btn",
  symbol,
) {
  return h(
    "button",
    {
      type: "button",
      class: className,
      "aria-label":
        label ||
        {
          details: "Container-Aktionen",
          calendar: "Monat wechseln",
          page: "Seite wechseln",
          close: "Dialog schließen",
          filter: "Ausschlüsse filtern",
        }[kind] ||
        kind,
      "data-kind": kind,
      "data-value": value,
      "data-id": id,
    },
    symbol
      ? icon(
          symbol,
          [
            "calendar",
            "clock",
            "history",
            "bell",
            "users",
            "link",
            "plus",
            "filter",
            "more",
            "ban",
            "cube",
            "docker",
          ].includes(symbol)
            ? "cuo"
            : "core",
        )
      : null,
    label,
  );
}
// Small keyed reconciler restricted to a custom element's own shadow root.
// User values enter text nodes or native value properties; never markup.
export function patch(parent, items) {
  items = (items || [])
    .flat(Infinity)
    .filter((v) => v !== null && v !== undefined && v !== false);
  const old = new Map([...parent.childNodes].map((n, i) => [n._key ?? i, n]));
  let previous = null;
  items.forEach((item, i) => {
    const text = typeof item !== "object",
      key = text ? i : (item.attrs.key ?? i);
    let node = old.get(key);
    old.delete(key);
    if (
      node &&
      (text ? node.nodeType !== 3 : node.nodeName.toLowerCase() !== item.tag)
    ) {
      node.remove();
      node = null;
    }
    if (!node) {
      node = text
        ? document.createTextNode("")
        : document.createElement(item.tag);
      node._key = key;
    }
    const position = previous ? previous.nextSibling : parent.firstChild;
    if (node !== position) parent.insertBefore(node, position);
    previous = node;
    if (text) {
      if (node.data !== String(item)) node.data = String(item);
      return;
    }
    const attrs = Object.fromEntries(
      Object.entries(item.attrs).filter(
        ([k, v]) => k !== "key" && v !== null && v !== undefined && v !== false,
      ),
    );
    for (const a of [...node.attributes])
      if (
        !(node.tagName === "DIALOG" && a.name === "open") &&
        !(a.name in attrs)
      )
        node.removeAttribute(a.name);
    for (const [k, v] of Object.entries(attrs)) {
      if (
        k === "value" &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName)
      ) {
        const next = String(v);
        if (node._cuoValue !== next) {
          if (node.getRootNode().activeElement !== node) node.value = next;
          node._cuoValue = next;
        }
      } else if (k === "checked") {
        if (node._cuoChecked !== !!v) {
          node.checked = !!v;
          node._cuoChecked = !!v;
        }
      } else {
        const value = v === true ? "" : String(v);
        if (node.getAttribute(k) !== value) node.setAttribute(k, value);
      }
    }
    if ("checked" in item.attrs && node._cuoChecked !== !!item.attrs.checked) {
      node.checked = !!item.attrs.checked;
      node._cuoChecked = !!item.attrs.checked;
    }
    patch(node, item.children);
    if (
      node.tagName === "SELECT" &&
      attrs.value !== undefined &&
      node._cuoSelection !== String(attrs.value)
    ) {
      node.value = attrs.value;
      node._cuoSelection = String(attrs.value);
    }
  });
  for (const n of old.values()) n.remove();
}
export const modeLabel = {
  "scan-only": "Nur prüfen",
  automatic: "Automatisch",
  "approval-required": "Manuelle Freigabe",
  disabled: "Deaktiviert",
};
export const stageLabel = {
  pending_approval: "Freigabe ausstehend",
  scheduled: "Geplant",
  queued: "In Warteschlange",
  preflight: "Vorprüfung",
  pulling: "Image laden",
  recreating: "Neuerstellung",
  verifying: "Healthcheck",
  succeeded: "Erfolgreich",
  failed: "Fehlgeschlagen",
  intervention_required: "Eingriff erforderlich",
  cancelled: "Abgebrochen",
};
export function formatDate(value) {
  if (/^\d{2}\.\d{2}\.\d{4}/.test(String(value))) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? String(value || "–")
    : d.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}
export class Widget extends HTMLElement {
  static get observedAttributes() {
    return ["data-view"];
  }
  attributeChangedCallback(name, oldValue, value) {
    if (name === "data-view" && value !== oldValue) {
      try {
        this.vm = JSON.parse(value);
      } catch {
        this.vm = {};
      }
    }
  }
  static get xtendComponentContract() {
    return {
      schema: "xtend.component.contract.v2",
      propertyNames: ["vm"],
      allowedProperties: ["vm"],
      properties: ["vm"],
      tag: this.tag,
      maturity: "mvp",
      profiles: ["cuo-widget"],
      runtime: { format: "esm", localOnly: true, cdnAllowed: false },
      rmt: {
        adapter: "xtend.component",
        kernelBoundary: "no-rmt-kernel-import-of-xtend-types",
      },
    };
  }
  static get xtendRmtMetadata() {
    return {
      schema: "xtend.rmt.component-contract.v1",
      propertyNames: ["vm"],
      allowedProperties: ["vm"],
      properties: ["vm"],
      tag: this.tag,
      adapter: "xtend.component",
      componentRecordKind: "custom_element",
      templateMode: "dom_descriptor",
      eventBindingMode: "dom-event-to-rmt-command",
      schedules: ["component.visible.mount", "component.visible.hydrate"],
      shellAuthoring: {
        host: this.tag,
        attributes: [],
        events: ["xtend-command"],
      },
    };
  }
  static get propSchema() {
    return {
      type: "object",
      properties: { vm: { type: "object" } },
      required: ["vm"],
      additionalProperties: false,
    };
  }
  static get eventContract() {
    return {
      "xtend-command": {
        bubbles: true,
        composed: true,
        detail: {
          kind: "string",
          value: "string?",
          id: "string?",
          data: "object?",
        },
      },
    };
  }
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/assets/components.css";
    this.shadowRoot.append(css);
    this.content = document.createElement("div");
    this.shadowRoot.append(this.content);
    const slot = document.createElement("slot");
    slot.name = "footer";
    this.shadowRoot.append(slot);
    this._vm = {};
    this.controller = null;
  }
  set vm(value) {
    if (!value || typeof value !== "object") return;
    this._vm = value;
    this.update();
  }
  get vm() {
    return this._vm;
  }
  connectedCallback() {
    this.controller = new AbortController();
    const opts = { signal: this.controller.signal };
    this.shadowRoot.addEventListener(
      "click",
      (e) => {
        const el = e.target.closest("[data-kind]");
        if (el && !el.disabled)
          this.emit(el.dataset.kind, el.dataset.value, el.dataset.id);
      },
      opts,
    );
    this.shadowRoot.addEventListener(
      "input",
      (e) => {
        if (e.target.dataset.input)
          this.emit(e.target.dataset.input, e.target.value);
      },
      opts,
    );
    this.shadowRoot.addEventListener(
      "change",
      (e) => {
        if (e.target.dataset.change)
          this.emit(e.target.dataset.change, e.target.value);
      },
      opts,
    );
    this.shadowRoot.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        this.submit?.(e.target);
      },
      opts,
    );
    this.update();
  }
  disconnectedCallback() {
    this.controller?.abort();
  }
  emit(kind, value = "", id = "", data) {
    this.dispatchEvent(
      new CustomEvent("xtend-command", {
        bubbles: true,
        composed: true,
        detail: { kind, value, id, data: data || {} },
      }),
    );
  }
  update() {
    patch(this.content, this.render?.() || []);
  }
}
export function register(tag, Class) {
  Class.tag = tag;
  if (!customElements.get(tag)) customElements.define(tag, Class);
}
export function field(label, name, value = "", type = "text", extra = {}) {
  return h(
    "label",
    { class: "field" },
    h("span", {}, label),
    h("input", { name, value, type, ...extra }),
  );
}
export function select(label, name, value, options) {
  return h(
    "label",
    { class: "field" },
    h("span", {}, label),
    h(
      "select",
      { name, value },
      options.map(([v, l]) => h("option", { value: v }, l)),
    ),
  );
}
