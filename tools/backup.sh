#!/bin/sh
set -eu
. "$(dirname "$0")/data-common.sh"
backup_file=${1:?Usage: ./tools/backup.sh /absolute/backup.tar.gz}
case "$backup_file" in /*) ;; *) echo 'Absolute backup path required' >&2; exit 1;; esac
[ ! -e "$backup_file" ] || { echo 'Refusing to overwrite existing backup' >&2; exit 1; }
mkdir -p "$(dirname "$backup_file")"
# Background scheduling can race this check. Archive validation repeats it after
# shutdown against the actual offline database before accepting the backup.
docker compose exec -T console node --input-type=module -e '
const response=await fetch((process.env.CUO_CORE_URL||"http://core:8091")+"/api/v1/update-jobs",{headers:{Authorization:"Bearer "+process.env.CUO_CORE_TOKEN,"X-CUO-Actor":"backup-check","X-CUO-Role":"Viewer","X-CUO-Hosts":"local"}});if(!response.ok)throw Error("Core must be reachable before backup");const data=await response.json();if(data.items.some(j=>!["succeeded","failed","cancelled","intervention_required"].includes(j.state))){console.error("Backup refused: finish/cancel all pending and active updates first.");process.exit(1)}'
umask 077
partial=$(mktemp "$backup_file.partial.XXXXXX")
restart=0
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  rm -f "$partial"
  if [ "$restart" = 1 ]; then docker compose up -d --no-build --pull never --wait >/dev/null || status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
restart=1
docker compose stop
data_archive > "$partial"
data_verify < "$partial"
# A hard link installs the finished backup without overwriting an existing path.
ln "$partial" "$backup_file"
printf 'Backup created and verified: %s\n' "$backup_file"
