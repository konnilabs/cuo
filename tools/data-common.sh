#!/bin/sh
# Shared by offline data tools. Never print resolved Compose configuration/secrets.
set -eu
cd "$(dirname "$0")/.."
data_container() {
  container=$(docker compose ps -aq "$1")
  case "$container" in ''|*'
'*) echo "Expected exactly one installed $1 container" >&2; exit 1;; esac
  printf '%s' "$container"
}
data_volume() {
  volume=$(docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "volume")}}{{.Name}}{{end}}{{end}}' "$(data_container "$1")")
  [ -n "$volume" ] || { echo "Expected a named /data volume for $1" >&2; exit 1; }
  printf '%s' "$volume"
}
identity_volume=$(data_volume console)
core_volume=$(data_volume core)
agent_volume=$(data_volume agent)
[ "$identity_volume" != "$core_volume" ] && [ "$identity_volume" != "$agent_volume" ] && [ "$core_volume" != "$agent_volume" ] || { echo 'CUO data volumes must be distinct' >&2; exit 1; }
data_image=$(docker inspect --format '{{.Image}}' "$(data_container core)")
data_verify() {
  docker run --rm --pull never --network none -i --user 0 --entrypoint cuo "$data_image" backup verify
}
data_archive() {
  docker run --rm --pull never --network none --user 0 --entrypoint tar \
    --mount "type=volume,source=$identity_volume,target=/identity,readonly" \
    --mount "type=volume,source=$core_volume,target=/core,readonly" \
    --mount "type=volume,source=$agent_volume,target=/agent,readonly" \
    "$data_image" -czf - -C / identity core agent
}
