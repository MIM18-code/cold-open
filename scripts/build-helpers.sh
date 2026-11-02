#!/bin/sh
# Release builds of the Swift helpers, with this checkout's path mapped away so the binaries carry no local paths
# (C++ assertions in MLX and fmt embed __FILE__).
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
for helper in speech-helper voice-helper; do
  dir="$root/native/$helper"
  (cd "$dir" && swift build -c release \
    -Xcc "-ffile-prefix-map=$dir=." -Xcxx "-ffile-prefix-map=$dir=." \
    -Xswiftc -file-prefix-map -Xswiftc "$dir=.")
done
