#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p .secrets
chmod 700 .secrets
registry_flag=
if [ "${1:-}" = "--with-registry" ]; then registry_flag=--registry; fi
# The already built Core image is the helper. Its provision command never
# prints secret values and refuses to replace an existing installation key.
registry_host=${CUO_ZOT_HOST:-}
if [ -z "$registry_host" ] && [ -f .env ]; then
  registry_host=$(awk '/^CUO_ZOT_HOST=/{sub(/^[^=]*=/, ""); value=$0} END{print value}' .env)
fi
registry_host=${registry_host:-localhost:5055}
docker run --rm --pull never --network none --user 0 \
  --mount "type=bind,source=$(pwd)/.secrets,target=/setup" \
  cuo-core:0.3.1 provision --directory /setup --owner-uid "$(id -u)" \
  --registry-host "$registry_host" $registry_flag
if [ -n "$registry_flag" ]; then
  docker compose --profile registry create --no-build zot
  zot_container=$(docker compose --profile registry ps -aq zot)
  zot_volume=$(docker inspect --format '{{range .Mounts}}{{if and (eq .Type "volume") (eq .Destination "/var/lib/registry")}}{{.Name}}{{end}}{{end}}' "$zot_container")
  [ -n "$zot_volume" ]
  docker run --rm --pull never --network none --user 0 --entrypoint sh \
    --mount "type=volume,source=$zot_volume,target=/registry" \
    cuo-core:0.3.1 -c 'chown 10001:10001 /registry; chmod 700 /registry'
fi
