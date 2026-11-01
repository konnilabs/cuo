#!/bin/sh
set -eu
# The old draft scanned one build and pushed a second build. That does not prove
# that the published digest passed its scan. Keep publication fail-closed until
# a build-once, digest-preserving, signed release workflow is implemented/tested.
cat >&2 <<'MESSAGE'
OCI publication is disabled for this development preview.
For local image/OS scans and CycloneDX SBOMs, build the images and run:
  node tools/check-images.mjs
See docs/RELEASE-GATES.md for the remaining publication and verification gates.
MESSAGE
exit 2
