#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
backup_file=${1:?Usage: ./tools/restore.sh /absolute/backup.tar.gz}
[ -f "$backup_file" ] || exit 1
# Concrete terminal confirmation for replacement of existing application data.
printf 'Replace CUO identity, policies, jobs and agent journals with this backup? Type RESTORE: '
read -r answer
[ "$answer" = RESTORE ] || exit 1
# Validate archive member paths before stopping any service.
if tar -tzf "$backup_file" | awk '(/^\// || /(^|\/)\.\.($|\/)/ || $0 !~ /^(identity|core|agent)(\/|$)/) {bad=1} END {exit bad?0:1}'; then
 echo 'Unsafe or unexpected archive member' >&2;exit 1
fi
docker compose stop
docker run --rm --network none -i -v cuo_identity:/identity -v cuo_core:/core -v cuo_agent:/agent alpine:3.22 sh -c 'find /identity /core /agent -mindepth 1 -delete && tar -xzf - -C /' < "$backup_file"
docker compose up -d
