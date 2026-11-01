import { Widget, register, h } from "./base.mjs";
import "../.framework/components/xtoast.js";
// RMT owns the queue. The Popover API only places its physical host in the
// browser's top layer, beyond every CSS stacking context (including XDrawer).
export class XCUOToasts extends Widget {
  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.addEventListener(
      "toast-dismissed",
      (event) => {
        this.emit("dismissToast", "", event.detail.id);
      },
      { signal: this.controller.signal },
    );
  }
  render() {
    return [
      h(
        "div",
        { class: "toast-stack" },
        (this.vm.toasts || []).map((toast) =>
          h(
            "x-toast",
            {
              key: toast.id,
              id: toast.id,
              type: toast.type,
              duration: toast.duration,
            },
            toast.message,
          ),
        ),
      ),
    ];
  }
  update() {
    super.update();
    if (!this.isConnected) return;
    const items = this.vm.toasts || [];
    const signature = items.map((toast) => toast.id).join(",");
    if (typeof this.showPopover === "function") {
      const open = this.matches(":popover-open");
      if (!items.length) {
        if (open) this.hidePopover();
      } else if (!open || signature !== this._presented) {
        if (open) this.hidePopover();
        this.showPopover();
      }
    } else this.toggleAttribute("data-fallback-open", !!items.length);
    this._presented = signature;
  }
  disconnectedCallback() {
    if (this.matches(":popover-open")) this.hidePopover();
    super.disconnectedCallback();
  }
}
register("x-cuo-toasts", XCUOToasts);
