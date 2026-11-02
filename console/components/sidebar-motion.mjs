import { Widget, register } from "./base.mjs";
import { XUtils } from "../.framework/components/xutils.js";
import { createRmtAnimationEngineRuntime } from "../.framework/xtendrmt/rmt-animation-engine-runtime.js";
import { createRmtDomDescriptorRenderer } from "../.framework/xtendrmt/rmt-dom-descriptor-renderer.js";

// RMT owns the mode and the DOM. This registered decoration owns only temporary
// animation handles; its presets are extracted from the compiled RMT plan.
export class XCUOSidebarMotion extends Widget {
  static get xtendRmtMetadata() {
    return {
      ...super.xtendRmtMetadata,
      schedules: ["component.visible.mount", "surface.transition.layout"],
    };
  }
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key === "Escape" &&
          this.vm.sidebarNarrow &&
          !this.vm.sidebarCollapsed
        )
          this.emit("sidebarClose");
      },
      { signal: this.controller.signal },
    );
    const signal = this.controller.signal;
    this.ready = fetch("/assets/sidebar-motion.json", { signal })
      .then((response) => {
        if (!response.ok) throw Error("Sidebar motion plan unavailable");
        return response.json();
      })
      .then((plan) => {
        if (!signal.aborted) this.plan = plan;
      })
      .catch(() => {
        // The CSS geometry/opacity fallback still reaches the RMT target state.
      });
  }
  update() {
    if (!this.isConnected) return;
    const collapsed = !!this.vm.sidebarCollapsed;
    const previous = this.collapsed;
    this.collapsed = collapsed;
    if (
      previous === undefined ||
      previous === collapsed ||
      this.vm.auth !== "ready"
    )
      return;
    cancelAnimationFrame(this.frame || 0);
    this.frame = requestAnimationFrame(() => this.animate(collapsed));
  }
  async animate(collapsed) {
    if (!this.plan || !this.isConnected) return;
    const shell = this.closest(".cuo-shell");
    const labels = [...shell.querySelectorAll(".sidebar [data-sidebar-label]")];
    const arrow = shell.querySelector("[data-sidebar-arrow]");
    const targets = [...labels, arrow].filter(Boolean);
    // Read before replacing an in-flight animation, so rapid reversals continue
    // from the currently visible frame rather than jumping to an old endpoint.
    const current = targets.map((target) => {
      const style = getComputedStyle(target);
      return { opacity: style.opacity, transform: style.transform };
    });
    this.stop();
    const generation = (this.generation || 0) + 1;
    this.generation = generation;
    this.renderer = createRmtDomDescriptorRenderer({
      documentTarget: document,
    });
    const engine = (this.engine = createRmtAnimationEngineRuntime({
      animationPlan: this.plan,
      xUtils: XUtils,
      domRenderer: this.renderer,
      windowTarget: window,
      strict: true,
    }));
    const handles = (this.handles = new Set());
    try {
      const results = await Promise.all(
        targets.map(async (target, i) => {
          const name =
            target === arrow
              ? collapsed
                ? "pointRight"
                : "pointLeft"
              : collapsed
                ? "hide"
                : "show";
          const preset = this.plan.animations.find(
            (item) => item.id === "cuo.sidebar." + name,
          );
          if (!preset) throw Error("Missing compiled sidebar animation");
          const keyframes = preset.keyframes.map((frame, index) =>
            index === 0
              ? { ...frame, properties: { ...frame.properties, ...current[i] } }
              : frame,
          );
          const before = new Set(target.getAnimations?.() || []);
          const work = engine.runSurfaceTransitionPhase({
            target,
            phase: "enter",
            transition: {
              ...preset,
              animation: preset.id,
              interrupt: "replace",
              keyframes,
            },
            metadata: { correlationId: "cuo-sidebar-" + generation },
          });
          for (const handle of target.getAnimations?.() || [])
            if (!before.has(handle)) handles.add(handle);
          return work;
        }),
      );
      if (this.generation === generation)
        this.last = {
          collapsed,
          results,
          diagnostics: engine.listDiagnostics(),
        };
    } catch {
      // Animation failure must never prevent navigation or retain stale effects.
    } finally {
      for (const handle of handles) handle.cancel();
      if (this.generation === generation) this.stop();
    }
  }
  snapshot() {
    return {
      ready: !!this.plan,
      active: this.engine?.listActiveAnimations().length || 0,
      last: this.last || null,
    };
  }
  stop() {
    this.engine?.dispose();
    this.engine = null;
    for (const handle of this.handles || []) handle.cancel();
    this.handles = null;
    this.renderer?.dispose(undefined, { clearOwnedDom: false });
    this.renderer = null;
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.generation = (this.generation || 0) + 1;
    cancelAnimationFrame(this.frame || 0);
    this.stop();
    this.collapsed = undefined;
  }
}
register("x-cuo-sidebar-motion", XCUOSidebarMotion);
