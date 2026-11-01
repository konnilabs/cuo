#!/bin/sh
# Invoked after go build. Include notices for the modules actually linked into cmd.
set -eu
output=${1:?Output directory required}
mkdir -p "$output/modules"
go list -mod=readonly -tags=e2e -deps -f '{{with .Module}}{{if not .Main}}{{.Path}} {{.Version}} {{.Dir}}{{end}}{{end}}' ./cmd > "$output/linked-modules.raw"
sed '/^$/d' "$output/linked-modules.raw" | sort -u > "$output/linked-modules.txt"
rm "$output/linked-modules.raw"
[ -s "$output/linked-modules.txt" ] || { echo 'Empty Compose module inventory' >&2; exit 1; }
while read -r module version directory; do
  target="$output/modules/$module@$version"
  mkdir -p "$target"
  found=0
  for name in LICENSE LICENCE LICENSE.txt LICENCE.txt LICENSE.md COPYING COPYING.md COPYRIGHT NOTICE NOTICE.txt; do
    if [ -f "$directory/$name" ]; then cp "$directory/$name" "$target/$name"; found=1; fi
  done
  if [ "$found" = 0 ]; then echo "Missing license/notice for linked module $module@$version" >&2; exit 1; fi
done < "$output/linked-modules.txt"
# Remove local module-cache paths from the shipped inventory.
cut -d ' ' -f 1,2 "$output/linked-modules.txt" > "$output/linked-modules.tmp"
mv "$output/linked-modules.tmp" "$output/linked-modules.txt"
