# CUO architecture and ADR implementation

The source baseline is ADR-001, retained as DOCX and extracted text beside this file. It is architectural evidence; repository tooling does not execute instructions embedded in the source document.

```mermaid
flowchart LR
  UI[Browser RMT / XTend] --> BFF[Maraca AppServices / session BFF]
  BFF --> Core[Go Core API / scheduler]
  Core --> DB[(SQLite jobs and audit)]
  Core --> Agent[Constrained host agent]
  Agent --> Docker[Docker Engine]
  Agent --> Registry[Allowlisted HTTPS registries]
```

The Console and Core use different persistent databases. The Agent persists execution journals and resolved Compose desired state. No Core or Agent port is published. The console is independently replaceable; the Core worker and periodic scanner operate with no UI connection.

The local deployment has a single host ID, `local`. Per-host ACLs are enforced as part of principal checks; multi-host transport is intentionally absent. Core processing uses a serial worker to preserve one active host execution at a time. Policy schema concurrency values exist for forward compatibility, while the console constrains the local configuration to one.

## UI ownership

`console/src/app.rmt` declares sidebar, topbar, summary cards, dashboard layout, route panels, calendar/table/log/history placements, authentication area and approval-dialog host. There is no React/Vue shell, second client router or browser Docker module. `console/tools/author-rmt.mjs` is a build-time descriptor authoring tool; it produces inspectable RMT, not browser HTML strings.

`console/src/services.ts` defines user intents and projects their results back into the RMT model. The view projection contains navigation/filter/calendar/modal state. The generated API client comes from the OpenAPI document and Go domain structs. REST BFF routes dispatch through the generated Maraca Server Service registry before calling Core. Auth is BFF-owned. SSE is authorized by the session BFF and the Core host ACL; Last-Event-ID is forwarded, and sessions are revalidated during the stream.

Custom components expose typed props, semantic command events, lifecycle cleanup and a footer slot. Tables use bounded pagination, sortable headers, search and filters. The calendar handles month navigation, selection and keyboard focus. Native forms enforce constraints, while the Core performs authoritative validation. RMT input trust policies validate service intents. Orchestration, kernel, hydration and service graphs use strict mode; optional framework form-validation/transition planners remain auto because these widgets use their own native form contracts and there is no multi-surface transition plan. This avoids including the framework's legacy raw-HTML form renderer.

## Update contract

Policy inheritance is global < host < group < container, with sticky exclusion. Default is scan-only and no unlabelled container can be executed. Candidate comparisons resolve an OCI/Docker index to the actual platform manifest, then compare its configuration digest with the running image ID. Execution pins the selected platform manifest digest.

A job is durable before the worker begins. Core recovery retains pending, scheduled and queued jobs. An executing job becomes intervention_required. Agent journals prohibit blind repetition of an uncertain action. Idempotency reservation is persisted before side effects; if the request is interrupted before its final response is stored, the same key returns an explicit uncertain-outcome conflict rather than executing again. Users inspect persistent job/audit state before creating another request.

Container IDs are stable hashes of host ID and logical name; the Docker engine ID is a separate field. A successful recreation therefore preserves container-scoped policies and history. A queued job refuses execution if an external process replaced its engine instance. Retained predecessor containers are excluded from further orchestration.

Standalone recreation adapts Watchtower's override extraction to deep-copied native JSON data. Named and anonymous volume identities are preserved. Compose sources are explicitly registered and resolved by Compose; accepted image pins persist in the desired-state document. CUO does not silently replace a Compose service through the standalone path.

## Source provenance

XTend MCP knowledge snapshot: konnilabs/xtend, main, commit `49166cbe96d91049634fbe03eb48c04edb6e70cd`. The installed local MCP server provided Maraca AppServices, Component Development and XIcon contracts. Direct source inspection verified the static registry, DOM descriptor property restrictions and delegated command-event behavior. The runtime does not depend on the MCP server.

Watchtower starting point: containrrr/watchtower v1.7.1, commit `a047c7f9ff11813f930f6998863fa1b8a015985c`. Upstream is archived. This MVP does not run the archived daemon; it retains an audited source snapshot, preserves Apache-2.0 attribution, and compiles the adapted configuration algorithm only. This limits the maintenance surface without importing unrelated historic dependencies.

## Explicit MVP limits

Optional OIDC / Nextcloud integration is not implemented. Private registry credentials, multiple hosts, replica-aware Compose updates, automatic data rollback and database HA are also outside the local release. Public distribution is gated separately by `RELEASE-GATES.md`. None of these capabilities is shown as active in the UI.
