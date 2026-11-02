#!/bin/sh
# Store this archive separately from the data backup: it decrypts integrations.
set -eu
cd "$(dirname "$0")/.."
file=${1:?Usage: ./tools/backup-key.sh /absolute/separate-secrets.tar.gz}
case "$file" in /*) ;; *) echo 'Absolute destination required' >&2; exit 1;; esac
[ ! -e "$file" ] || { echo 'Refusing to overwrite destination' >&2; exit 1; }
umask 077
mkdir -p "$(dirname "$file")"
temp=$(mktemp "$file.partial.XXXXXX")
trap 'rm -f "$temp"' EXIT HUP INT TERM
image=$(docker inspect --format '{{.Image}}' "$(docker compose ps -aq core)")
docker run --rm --pull never --network none --user 0 --entrypoint sh \
  --mount "type=bind,source=$(pwd)/.secrets,target=/secrets,readonly" \
  "$image" -c 'cd /secrets; test -f integration.key; set -- integration.key zot-client.json; if test -f zot-ci.env; then set -- "$@" zot-ci.env; fi; tar -czf - "$@"' > "$temp"
ln "$temp" "$file"
printf 'Separate installation-secret backup created: %s\n' "$file"
