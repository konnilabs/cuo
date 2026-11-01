# Compose security backport

The Agent uses **v5.6.1-cuo.1**, a local build of upstream Docker Compose **v5.6.1**
(`6cbc19a3fd59e305fb814dca4d854a4fb67d2941`). This is not an official Docker release.
Only `go.mod` and `go.sum` differ from that source archive. The Compose application
code is unchanged.

`security.patch` backports upstream security commit
[`7ad5c58b380038aed842bc1396b091e81a88a0b0`](https://github.com/docker/compose/commit/7ad5c58b380038aed842bc1396b091e81a88a0b0):

| Dependency | Upstream v5.6.1 | CUO backport |
|---|---|---|
| `golang.org/x/net` | v0.58.0 | v0.60.0 |
| `golang.org/x/crypto` | v0.56.0 | v0.57.0 |
| `golang.org/x/text` | v0.41.0 | v0.42.0 |

The accompanying `x/term` checksums follow the upstream security change. The patch
is adjusted only for v5.6.1's surrounding lockfile context. It adds no other main
branch features and does not modify CUO's own Go module graph.

`compose.lock` is trusted POSIX assignment data used by the Docker build and
strictly parsed by the Node verification/notices tools. It pins the release
commit, source archive SHA-256, upstream security commit, local patch SHA-256 and
both resulting Go module-file SHA-256 values. `prepare.sh` rejects a pre-existing
destination and invalid content, applies the patch with zero fuzz and verifies
the exact result. No source archive or generated binary is vendored in Git.

The plugin build uses digest-pinned Go 1.26.10, matching upstream's compiler,
with `GOTOOLCHAIN=local`, verifies
downloaded modules, builds with `-mod=readonly`, `-trimpath`, `-buildvcs=false` and
upstream's `e2e` build tag and `-w` linker setting, then rechecks the module files.
The symbol table is retained, so binary analysis does not fall back to a less
precise module-only assessment. CUO's own Core/Agent binaries still use Go 1.27.3.
The plugin sets a distinct
plugin version instead of pretending to be the unmodified upstream release.
BuildKit caches modules/compilation; `-p 2` limits concurrent compilation on CI.
The fetched archive and source files stay in the build stage. The runtime
receives the static plugin, lock/patch, binary checksum, Go build info, original
Compose license/NOTICE and licenses for modules actually linked into the plugin.

```sh
docker compose build agent
node tools/verify-compose.mjs
CUO_DOCKER_E2E=1 go test -v ./internal/agent -run TestDisposableComposeReconcile -count=1
# Requires installed Trivy/Syft and a fresh evidence directory:
CUO_IMAGE_REPORTS=work/compose-image-checks node tools/check-images.mjs
```

`verify-compose.mjs` reads the executable from an immutable Agent image ID and
checks its actual Go build information, all three updated dependencies, custom
version, embedded source lock, binary hash and symbol information, then runs
the pinned `govulncheck v1.9.0` against that exact executable. A scan failure
fails verification; no advisory is suppressed. CI runs this before the disposable
Compose test. The manifest in `reports/compose-backport.json` records the tested
binary/image identities. This local record is not signed OCI provenance.

The original HIGH-CVE is fixed, and the local image HIGH/CRITICAL gate passes.
The final `govulncheck -mode=binary` scan reports **zero affected symbols**.
Three module-version advisories remain: GO-2026-5932 (the unmaintained
x/crypto/openpgp package), GO-2026-6860 and GO-2026-6866 (x/net/html; fixed upstream
in v0.62.0). The tool reports that this binary does not appear to call the affected
code; Trivy still displays these version-based findings as UNKNOWN. They remain
visible in the evidence and release matrix. This is a scoped assessment of the
recorded executable, not a claim that every package in these modules is safe.
Repeat both the binary and image scans when changing the build or dependencies.

Replace this backport with a digest-pinned official Compose release once its
actual executable includes the fix and the same image scan/Compose tests pass.
Until then, dependency maintenance of this custom build belongs to CUO. Updating
the baseline or patch requires reviewing the diff, regenerating all hashes and
notices, and rerunning the tests; no mutable `main` or `latest` reference is used.
