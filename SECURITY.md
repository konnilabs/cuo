# CUO security model

CUO 0.1.0 is a local single-host MVP. Do not expose the internal Core or Agent ports. Report vulnerabilities privately to the future repository maintainer; a public disclosure endpoint has not yet been configured.

## Trust boundaries

* The browser is untrusted. HttpOnly / SameSite Strict cookies identify sessions; Secure is mandatory for HTTPS ingress. Loopback HTTP is the deliberate local-install exception. Sessions expire after twelve hours and can be revoked. The BFF checks exact Origin and a per-session CSRF token before authenticated mutations. Passwords use scrypt with per-user random salts; tokens are not put in localStorage.
* The BFF owns users and sessions in a separate SQLite database. It supplies Core principals from the session; browser-provided role headers are never forwarded. All Core mutations require idempotency keys. Unknown operations are rejected by an explicit route allowlist.
* The Core is an independent headless Go engine. A separate random bearer token authenticates internal BFF requests. Viewer, Operator, Administrator and Owner permissions and local-host authorization are checked again in the Core. Durable audit events do not contain raw Docker configurations or registry tokens.
* The Agent alone mounts the Docker socket. A different random bearer token authenticates its four typed routes: health, info/inventory, registry scan and update execution. There is no generic Docker proxy, arbitrary shell endpoint or host-file editor. A managed-container label, policy, digest, platform and drift checks are required before disruption.

Docker socket possession is effectively host authority. The agent is **not** an OS security sandbox. Trusted project source files may contain secret interpolation and powerful Docker settings; only host-owner-approved Compose sources belong in the registered projects directory. Keep its read-only mount narrow. Untrusted users must never be allowed to upload Compose projects into that directory.

## Rendering and component contracts

The RMT document owns the shell, routing state, selectors, intents and widget lifecycle. The static Maraca registry is built from `console/components/manifest.json`. Custom widgets use `xtend.component.contract.v2` and `xtend.rmt.component-contract.v1`, with a typed `vm` contract projected through a JSON `data-view` attribute. JSON parsing never evaluates code. The emitted `xtend-command` event contains `{kind,value,id,data}`; RMT maps it to a registered AppService. Components never write into surrounding shell DOM.

Each widget owns only its shadow-root physical nodes and native draft/focus behavior. Its small keyed reconciler creates native elements and text nodes; it preserves nodes, input drafts and native dialog modal state. Event listeners are disposed using an AbortController. Optional `footer` slot content is host-authored. Table output is bounded to eight rows per page, log output to twelve visible entries from a bounded 200-event view buffer.

Native dialog `showModal/close` and calendar arrow-key focus are the reviewed imperative integrations. They affect only physical focus / modal presentation inside the component and do not own application navigation or visibility. Visibility remains in RMT. Untrusted image references, logs, actor names and registry errors become text nodes, never markup.

The deployed CSP disallows remote scripts, inline scripts, object embedding and framing. It requires Trusted Types where supported. Inline **styles** remain allowed because XTend XIcon creates a local style element and sets documented icon variables. No remote fonts or script CDNs are used.

The pinned framework contains legacy raw-HTML paths that CUO does not use. `console/tools/harden-runtime.mjs` replaces the two actual assignment sites in the emitted runtime with fail-closed errors, records before/after hashes, and rejects any unreviewed HTML sink. This is an explicit deployment adaptation; the original third-party source archive is unchanged. Switching the application to legacy HTML templates requires a separate security review and is unsupported. The framework's legacy `x-input` HTML implementation is not included in CUO's selected component graph.

## Execution and recovery

Updates use immutable per-platform registry manifests. Public registry authentication realms are constrained to the registry host, with Docker Hub's documented `auth.docker.io` exception; redirects and unknown registries are rejected. Private registry credentials are not yet supported. Image healthcheck output and Docker error response bodies are not returned to users.

The agent rechecks the running image and configuration after pulling. It preserves actual volume names and runtime overrides. It retains the old standalone container stopped, with restart policy disabled. Database/volume rollback is deliberately not automatic. Interrupted executions require intervention and are protected against duplicate agent replay by durable journals. BFF disconnect does not cancel an already durable job.

Agent journals and Compose desired-state files are persisted; the latter may contain resolved environment secrets. Protect `/data`, backups and `.env` accordingly. There is no automatic retention pruning yet. Backup scripts stop only CUO, never managed workloads. Restore requires explicit terminal confirmation because it replaces application data.

## Dependency and release review

`third_party/` contains exact upstream source snapshots and licenses. Only the modified Watchtower configuration-override algorithm is compiled into CUO; the upstream Watchtower daemon, webhook handlers, notification stack and their dependency graph are not linked. The source commit is `a047c7f9ff11813f930f6998863fa1b8a015985c`.

The original XTend workspace includes MCP-server packages unrelated to this product. The build selects only Maraca/CLI/RMT/compiler workspaces. The deployed Node process uses Node built-ins and bundled Maraca server-service host files; it has no installed npm dependency tree. Record build-tool audit results separately from runtime applicability, never silently suppress findings.

CI checks source and output sinks, Go tests/race checks/vet, typed services, RMT lint, build contracts, dependencies and secret patterns. Signed OCI publication, image scanning, provenance, a complete SBOM and broad WCAG testing remain release gates. A successful local build alone is not public-release approval.
