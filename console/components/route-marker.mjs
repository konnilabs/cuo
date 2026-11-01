// XRouter owns URL matching, history and route events; RMT owns the page surfaces.
if (!customElements.get("x-cuo-route"))
  customElements.define("x-cuo-route", class extends HTMLElement {});
