import { Widget, register, h, patch } from "./base.mjs";
import { registerIconPack } from "../.framework/components/xicon.js";
import { resolveContainerIcon } from "./container-icon-catalog.mjs";
import { createBrandLoader } from "./brand-loader.mjs";

const loadBrands = createBrandLoader({
  fetchPack: (...args) => fetch(...args),
  registerPack: registerIconPack,
});

export class XContainerIcon extends Widget {
  static loadPack() {
    return loadBrands();
  }
  static get observedAttributes() {
    return ["image", "theme", "icon-key"];
  }
  static get xtendComponentContract() {
    return {
      ...super.xtendComponentContract,
      propertyNames: ["image", "theme", "iconKey"],
      allowedProperties: ["image", "theme", "iconKey"],
      properties: ["image", "theme", "iconKey"],
    };
  }
  static get xtendRmtMetadata() {
    return {
      ...super.xtendRmtMetadata,
      propertyNames: ["image", "theme", "iconKey"],
      allowedProperties: ["image", "theme", "iconKey"],
      properties: ["image", "theme", "iconKey"],
      shellAuthoring: {
        host: this.tag,
        attributes: ["image", "theme", "icon-key"],
        events: [],
      },
    };
  }
  static get propSchema() {
    return {
      type: "object",
      properties: {
        image: { type: "string" },
        theme: { type: "string", enum: ["light", "dark"] },
        iconKey: { type: "string" },
      },
      required: ["image"],
      additionalProperties: false,
    };
  }
  get image() {
    return this.getAttribute("image") || "";
  }
  set image(value) {
    this.setAttribute("image", value);
  }
  get theme() {
    return this.getAttribute("theme") || "light";
  }
  set theme(value) {
    this.setAttribute("theme", value);
  }
  get iconKey() {
    return this.getAttribute("icon-key") || "";
  }
  set iconKey(value) {
    this.setAttribute("icon-key", value);
  }
  attributeChangedCallback() {
    this.update();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.request = (this.request || 0) + 1;
    this.pending = false;
  }
  snapshot() {
    return { ...this.selection, state: this.state || "fallback" };
  }
  update() {
    const signature = JSON.stringify([this.image, this.theme, this.iconKey]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.selection = resolveContainerIcon(this.image, {
        theme: this.theme,
        iconKey: this.iconKey,
      });
      this.state = this.selection.key ? "loading" : "fallback";
      this.request = (this.request || 0) + 1;
      this.pending = false;
    }
    this.paint();
    if (!this.isConnected || this.state !== "loading" || this.pending) return;
    const request = this.request;
    this.pending = true;
    this.constructor.loadPack().then(
      (pack) => {
        if (request !== this.request || !this.isConnected) return;
        this.state = Object.hasOwn(pack.icons, this.selection.icon)
          ? "ready"
          : "error";
        this.pending = false;
        this.paint();
      },
      () => {
        if (request !== this.request || !this.isConnected) return;
        this.state = "error";
        this.pending = false;
        this.paint();
      },
    );
  }
  paint() {
    if (!this.content || !this.selection) return;
    const ready = this.state === "ready",
      choice = this.selection;
    patch(this.content, [
      h(
        "span",
        {
          class: "app-symbol app-" + choice.tone,
          "aria-hidden": "true",
          "data-icon-state": this.state,
          "data-brand": choice.key || "",
          title: ready ? choice.label : "Container-Symbol",
        },
        h("x-icon", {
          name: ready ? choice.icon : choice.fallback.name,
          pack: ready ? "cuo-brands" : choice.fallback.pack,
          size: "22px",
          decorative: true,
        }),
      ),
    ]);
  }
}
register("x-container-icon", XContainerIcon);
