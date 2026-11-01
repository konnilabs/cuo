#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker compose exec -T console node server/recover-login.mjs
