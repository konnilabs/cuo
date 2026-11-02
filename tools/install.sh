#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null
docker compose version >/dev/null
umask 077
registry=0
if [ "${1:-}" = "--with-registry" ]; then registry=1; elif [ "$#" -gt 0 ]; then echo 'Usage: ./tools/install.sh [--with-registry]' >&2; exit 1; fi
if [ ! -f .env ]; then
  umask 077
  core_token=$(od -vN32 -An -tx1 /dev/urandom | tr -d ' \n')
  agent_token=$(od -vN32 -An -tx1 /dev/urandom | tr -d ' \n')
  cat > .env <<ENV
CUO_CORE_TOKEN=$core_token
CUO_AGENT_TOKEN=$agent_token
CUO_ORIGIN=http://127.0.0.1:8095
CUO_PORT=8095
CUO_SCAN_INTERVAL=6h
ENV
fi
mkdir -p projects
docker compose build
if [ "$registry" = 1 ]; then
  ./tools/prepare-secrets.sh --with-registry
  settings=$(mktemp .env.registry.XXXXXX)
  awk '
    /^CUO_ZOT_ENABLED=/{next}
    /^COMPOSE_PROFILES=/{sub(/^COMPOSE_PROFILES=/, ""); profiles=$0; next}
    {print}
    END {print "CUO_ZOT_ENABLED=1"; if (profiles !~ /(^|,)registry(,|$)/) profiles=profiles (profiles ? "," : "") "registry"; print "COMPOSE_PROFILES=" profiles}
  ' .env > "$settings"
  mv "$settings" .env
  CUO_ZOT_ENABLED=1 docker compose --profile registry up -d --no-build --wait
else
  ./tools/prepare-secrets.sh
  docker compose up -d --no-build --wait
fi
printf '\nCUO: http://127.0.0.1:8095 — ersten Administrator im Browser einrichten.\n'
