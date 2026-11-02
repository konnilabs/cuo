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
zot_volume=
registry_config=
zot_container=$(docker compose --profile registry ps -aq zot 2>/dev/null || true)
if [ -n "$zot_container" ]; then
  zot_volume=$(docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/var/lib/registry") (eq .Type "volume")}}{{.Name}}{{end}}{{end}}' "$zot_container")
  registry_config=$(docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/etc/zot") (eq .Type "bind")}}{{.Source}}{{end}}{{end}}' "$zot_container")
  [ -n "$zot_volume" ] && [ -d "$registry_config" ] || { echo 'Integrated registry mounts are incomplete' >&2; exit 1; }
fi
data_verify() {
  docker run --rm --pull never --network none -i --user 0 --entrypoint cuo "$data_image" backup verify
}
data_run() {
  action=$1
  access=readonly
  if [ "$action" = restore ]; then access=; fi
  set -- --mount "type=volume,source=$identity_volume,target=/identity${access:+,$access}" \
    --mount "type=volume,source=$core_volume,target=/core${access:+,$access}" \
    --mount "type=volume,source=$agent_volume,target=/agent${access:+,$access}"
  if [ -n "$zot_volume" ]; then
    set -- "$@" --mount "type=volume,source=$zot_volume,target=/zot${access:+,$access}" \
      --mount "type=bind,source=$registry_config,target=/registry-config${access:+,$access}"
  fi
  docker run --rm --pull never --network none -i --user 0 --entrypoint cuo "$@" "$data_image" backup "$action"
}
data_archive() { data_run create; }
