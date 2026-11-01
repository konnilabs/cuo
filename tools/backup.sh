#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
backup_file=${1:?Usage: ./tools/backup.sh /absolute/backup.tar.gz}
case "$backup_file" in /*) ;; *) echo 'Absolute backup path required' >&2;exit 1;; esac
if [ -e "$backup_file" ]; then echo 'Refusing to overwrite existing backup' >&2;exit 1;fi
mkdir -p "$(dirname "$backup_file")"
# Refuse to interrupt an already executing durable operation.
docker compose exec -T console node --input-type=module -e '
const response=await fetch((process.env.CUO_CORE_URL||"http://core:8091")+"/api/v1/update-jobs",{headers:{Authorization:"Bearer "+process.env.CUO_CORE_TOKEN,"X-CUO-Actor":"backup-check","X-CUO-Role":"Viewer","X-CUO-Hosts":"local"}});if(!response.ok)throw Error("Core must be reachable before backup");const data=await response.json();if(data.items.some(j=>["preflight","pulling","recreating","verifying","queued"].includes(j.state))){console.error("Backup refused: finish/cancel queued and active updates first.");process.exit(1)}'
# Only CUO services are stopped. Workload containers keep running.
docker compose stop
trap 'docker compose up -d >/dev/null' EXIT HUP INT TERM
umask 077
docker run --rm --network none -v cuo_identity:/identity:ro -v cuo_core:/core:ro -v cuo_agent:/agent:ro alpine:3.22 tar -czf - -C / identity core agent > "$backup_file"
chmod 600 "$backup_file"
printf 'Backup created: %s\n' "$backup_file"
