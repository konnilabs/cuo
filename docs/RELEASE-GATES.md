# Public release gates

CUO 0.1.0 is delivered as a local source-build MVP. The source repository is hosted on GitHub. No OCI push, image signature or public image release is created by this implementation task.

| Gate | Local evidence / required release evidence |
|---|---|
| RMT compile and service contracts | `console/reports/maraca-plan.json`, `maraca-build.json`, `rmt-lint.json` |
| Application and emitted-runtime HTML sinks | Build source gate and `runtime-hardening.json`; fail on new sink sites |
| Domain and recovery | Go race tests, DST/repeated/skipped time, one-minute collisions, policy inheritance, idempotency, cancellation, restart |
| Docker execution | Opt-in disposable real Docker E2E; verifies changed image, volume data, environment, labels, health and retained stopped original |
| UI | Actual browser navigation, filters, dialogs, keyboard, dark/mobile, XRouter history/reload, live system theme, durable notification dismissal, profile drawer, signed OIDC browser login, text-only XSS, first-run enrollment, live inventory, CSRF, Origin, RBAC |
| SCA | `govulncheck` against patched Go 1.27.3; npm audit scoped to the actual build workspaces and the pinned OIDC runtime tree |
| Backup / restore | Verify all three volumes using isolated restore volumes; protect resolved Compose secrets |
| Secret review | No `.env`, database, key or runtime credential tracked; inspect `tools/check-secrets.mjs` output |
| OCI vulnerability scans | Required before public distribution; local source tests do not replace image/OS scans |
| SBOM and provenance | Complete image SBOMs including OS packages and build attestations required |
| Signing and publication | Explicit versioned digest publication and cosign verification with the eventual repository identity |
| Accessibility | Keyboard/mobile smoke performed locally; complete WCAG 2.2 AA audit and approved visual baselines still required |
| Compose support matrix | Single-replica registered-source reconciliation; broader projects, secrets/config edge cases and additional Docker versions require certification |

`.github/workflows/ci.yml` performs source, Core, compiler, runtime, disposable Docker and browser gates on a clean runner. It never publishes images. `tools/release.sh` is a separate explicit publication command that requires authenticated registry access and installed `trivy`, `syft` and `cosign`; it scans before publication and requests BuildKit SBOM/provenance attestations. Run it only after all gates and the target GitHub/registry identity are agreed.

The local standalone update test is evidence for the tested single-container path. It is not a claim of full production certification of every Docker configuration. Container data migrations, external Compose operations without CUO's persisted desired state, host failure and incomplete backup contracts require operator responsibility.
