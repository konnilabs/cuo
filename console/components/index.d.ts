import type { VM, Intent } from "../src/contracts";
/** Registry v1. Props are projected by RMT through data-view as validated JSON. */
export interface CUOWidget extends HTMLElement {
  vm: Readonly<VM>;
  readonly content: HTMLElement;
  emit(
    kind: string,
    value?: string,
    id?: string,
    data?: Record<string, unknown>,
  ): void;
}
export interface CUOIntentEvent extends CustomEvent<Intent> {
  readonly type: "xtend-command";
}
export interface CUOComponentContract {
  schema: "xtend.component.contract.v2";
  propertyNames: ["vm"];
  slots: ["footer"];
  events: {
    "xtend-command": { detail: Intent; bubbles: true; composed: true };
  };
}
declare global {
  interface HTMLElementTagNameMap {
    "x-container-table": CUOWidget;
    "x-maintenance-planner": CUOWidget;
    "x-update-run-timeline": CUOWidget;
    "x-log-stream": CUOWidget;
    "x-policy-editor": CUOWidget;
    "x-host-health": CUOWidget;
    "x-approval-dialog": CUOWidget;
    "x-update-status-badge": CUOWidget;
    "x-cuo-auth": CUOWidget;
    "x-cuo-workspace": CUOWidget;
  }
}
