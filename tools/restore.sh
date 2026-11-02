#!/bin/sh
set -eu
. "$(dirname "$0")/data-common.sh"
backup_file=${1:?Usage: ./tools/restore.sh /absolute/backup.tar.gz}
case "$backup_file" in /*) ;; *) echo 'Absolute backup path required' >&2; exit 1;; esac
[ -f "$backup_file" ] || exit 1
# Check the full archive and database schemas before stopping any service.
data_verify < "$backup_file"
printf 'Replace CUO identity, policies, jobs and agent journals? Type RESTORE: '
read -r answer
[ "$answer" = RESTORE ] || exit 1
umask 077
# Keep a recovery point if replacing one of the three volumes fails.
safety=$(mktemp "${backup_file}.before-restore.XXXXXX")
docker compose stop
data_archive > "$safety"
printf 'Protected pre-restore snapshot: %s\n' "$safety"
if ! data_run restore < "$backup_file"; then
  echo 'Restore failed. CUO remains stopped. Retain the pre-restore snapshot for manual recovery.' >&2
  exit 1
fi
docker compose up -d --no-build --pull never --wait
