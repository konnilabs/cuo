#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${CUO_REGISTRY:?Set a repository registry prefix, e.g. ghcr.io/owner/cuo}"
: "${VERSION:?Set an explicit release version}"
for command in docker cosign syft trivy node; do command -v "$command" >/dev/null || exit 1; done
mkdir -p reports/release
for service in core agent console; do
  image="$CUO_REGISTRY-$service:$VERSION"
  if [ "$service" = console ]; then
    docker build -f console/Dockerfile -t "$image" .
  else
    docker build --target "$service" -t "$image" .
  fi
  trivy image --exit-code 1 --severity HIGH,CRITICAL --format json --output "reports/release/$service-vulnerabilities.json" "$image"
  syft "$image" -o "cyclonedx-json=reports/release/$service-sbom.json"
  # Publication is reached only after this image has passed its scanner gate.
  if [ "$service" = console ]; then
    docker buildx build -f console/Dockerfile --push --provenance=mode=max --sbom=true --metadata-file "reports/release/$service-metadata.json" -t "$image" .
  else
    docker buildx build --target "$service" --push --provenance=mode=max --sbom=true --metadata-file "reports/release/$service-metadata.json" -t "$image" .
  fi
  digest=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1]))["containerimage.digest"])' "reports/release/$service-metadata.json")
  cosign sign --yes "$CUO_REGISTRY-$service@$digest"
done
