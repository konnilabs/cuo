# Verification evidence

These are point-in-time development records, not a stable-release certificate.

- `release-readiness.json`: current local release assessment, image IDs/source fingerprints and open gates.
- `restore-test.json`: newest isolated execution of the real three-volume backup/restore tools, including login after restart. The disposable project and test archives are removed afterwards.
- `image-checks/`: ignored full local Trivy/Syft reports and SBOMs; a manual GitHub preflight uploads the equivalent directory as an Actions artifact. Image findings must be rerun against final artifacts and a fresh vulnerability database.
- Other files, including `verification.json` and `restore-integrity.txt`, are historical evidence of the revisions/images named there. Old fields such as `githubRemoteConfigured: false` or an optional OIDC integration being pending describe the old snapshot and do not override the current README.

Checks generated from a dirty worktree explicitly record that fact. Neither a report's presence nor an old green CI run approves later changes. Never commit database files, raw backup archives, runtime credentials or resolved Compose configuration to this directory.
