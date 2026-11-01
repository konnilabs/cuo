#!/bin/sh
set -eu
dependency_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$dependency_dir/compose.lock"
archive=${1:?Usage: prepare.sh /absolute/source.tar.gz /absolute/new-directory}
destination=${2:?Usage: prepare.sh /absolute/source.tar.gz /absolute/new-directory}
case "$archive:$destination" in /*:/*) ;; *) echo 'Absolute paths required' >&2; exit 1;; esac
[ ! -e "$destination" ] && [ ! -L "$destination" ] || { echo 'Refusing to replace an existing destination' >&2; exit 1; }
printf '%s  %s\n' "$COMPOSE_SOURCE_SHA256" "$archive" | sha256sum -c -
printf '%s  %s\n' "$COMPOSE_PATCH_SHA256" "$dependency_dir/security.patch" | sha256sum -c -
mkdir -p "$destination"
tar -xzf "$archive" --strip-components=1 -C "$destination"
cd "$destination"
patch --batch --fuzz=0 -p1 < "$dependency_dir/security.patch"
printf '%s  go.mod\n%s  go.sum\n' "$COMPOSE_MOD_SHA256" "$COMPOSE_SUM_SHA256" | sha256sum -c -
