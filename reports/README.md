# Verification evidence

These are point-in-time development records, not a stable-release certificate.

- `sidebar-0.2.0.json`: follow-up assessment for the animated RMT sidebar, with updated image IDs and desktop/mobile/reduced-motion browser checks.
- `local-0.2.0.json`: initial local 0.2.0 development assessment, exact image IDs, test evidence hashes and open external gates. Raw new scan/SBOM and browser artifacts stay in the protected local evidence directory named in this report.
- `dependency-inventory.json`: current source dependency inventory; image SBOMs are separate evidence.
- `release-readiness.json`: historical 0.1 local release assessment, image IDs/source fingerprints and open gates.
- `restore-test.json`: newest isolated execution of the real three-volume backup/restore tools, including login after restart. The disposable project and test archives are removed afterwards.
- `compose-backport.json`: actual executable verification of the pinned Compose security backport, including module versions, binary hash and Agent image ID.
- `compose-govulncheck.txt`: precise Go binary scan with retained symbols; zero affected symbols in the final build. Three module-only advisories remain visible and require revalidation against the final release binary.
- `image-checks/`: ignored full local Trivy/Syft reports and SBOMs; a manual GitHub preflight uploads the equivalent directory as an Actions artifact. Image findings must be rerun against final artifacts and a fresh vulnerability database.
- Other files, including `verification.json` and `restore-integrity.txt`, are historical evidence of the revisions/images named there. Old fields such as `githubRemoteConfigured: false` or an optional OIDC integration being pending describe the old snapshot and do not override the current README.

Checks generated from a dirty worktree explicitly record that fact. Neither a report's presence nor an old green CI run approves later changes. Never commit database files, raw backup archives, runtime credentials or resolved Compose configuration to this directory.
