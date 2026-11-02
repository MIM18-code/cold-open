#!/bin/sh
# Build build/icon.icns and build/icon-1024.png from the brand mark (build/brand/mark.svg). Needs rsvg-convert
# (brew install librsvg) and macOS's iconutil.
set -eu
cd "$(dirname "$0")/.."
set_dir=$(mktemp -d)/ColdOpen.iconset
mkdir -p "$set_dir"
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" build/brand/mark.svg -o "$set_dir/icon_${size}x${size}.png"
  rsvg-convert -w $((size * 2)) -h $((size * 2)) build/brand/mark.svg -o "$set_dir/icon_${size}x${size}@2x.png"
done
rsvg-convert -w 1024 -h 1024 build/brand/mark.svg -o build/icon-1024.png
iconutil -c icns "$set_dir" -o build/icon.icns
rm -rf "$(dirname "$set_dir")"
echo "build/icon.icns"
