import type { VM } from "../src/contracts.ts";
export interface IntegrationSubmission {
  op: string;
  values: Record<string, string | boolean>;
}
export interface IntegrationElement extends HTMLElement {
  vm: VM;
  takeSubmission(token: string): IntegrationSubmission;
  finishSubmission(): void;
  beginRegistration(data: {
    installationURL?: string;
    registrationURL?: string;
    manifest?: unknown;
  }): void;
}
declare global {
  interface HTMLElementTagNameMap {
    "x-unioci-registry-list": IntegrationElement;
    "x-unioci-registry-settings": IntegrationElement;
    "x-unioci-repository-browser": IntegrationElement;
    "x-unioci-artifact-detail": IntegrationElement;
    "x-cuo-github-connection": IntegrationElement;
    "x-cuo-webhook-inbox": IntegrationElement;
    "x-cuo-release-subscriptions": IntegrationElement;
    "x-cuo-permission-matrix": IntegrationElement;
  }
}
