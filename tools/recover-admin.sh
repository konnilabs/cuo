#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Interactive terminal; password is not passed as a command-line argument.
docker compose exec console node server/recover-admin.mjs
