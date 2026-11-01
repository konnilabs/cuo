#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null
docker compose version >/dev/null
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
docker compose up -d --build
printf '\nCUO: http://127.0.0.1:8095 — ersten Administrator im Browser einrichten.\n'
