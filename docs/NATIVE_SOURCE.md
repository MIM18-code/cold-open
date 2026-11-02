# Native runtime source

Cold Open distributes Electron 44.2.0 without modifying its native binaries.
Electron's release configuration builds FFmpeg as a shared library. It uses
Chromium 152.0.7977.76 and Node v24.20.0. Chromium pins its FFmpeg fork to
`2b68d2babae73714846961fb0ee47e3b3d2e39a9`.

Every binary release must be accompanied by the archives named in
`scripts/prepare-native-source.mjs`. That script downloads the source and
checks its SHA-256. Publish those archives beside the Cold Open source and DMG;
do not replace them with a link to FFmpeg's current default branch.

The FFmpeg archive contains Chromium's FFmpeg fork and generated platform
configurations. Its Chrome/mac/arm64/config.h sets CONFIG_GPL, CONFIG_NONFREE,
CONFIG_VERSION3 and CONFIG_GPLV3 to zero.

The Chromium 152.0.7977.76 archive contains the complete Chromium repository
snapshot, including its modified Opus implementation, headers, license and
patent notices, and the Chromium build files. Opus's README.chromium records
upstream revision 55513e81d8f606bd75d0ff773d2144e5f2a732f5 and Chromium's local
changes. The FFmpeg adapter alone is not the Opus implementation.

Electron's archive contains its additional FFmpeg patch, patch application
tools, release GN arguments and native build instructions. Retain all native source
archives. The release check verifies their pinned hashes and requires the
Opus implementation and Chromium build inputs inside the archive.

To lay out the supplied source, extract Chromium into a directory named src,
removing the archive's chromium-152.0.7977.76 prefix. Extract Electron into
src/electron, removing its electron-44.2.0 prefix. Extract the FFmpeg archive
into src/third_party/ffmpeg. Apply Electron's patches/ffmpeg/.patches list to
the FFmpeg tree. Extract the pinned NASM archive into src/third_party/nasm;
FFmpeg imports its nasm_assemble.gni build template even though the macOS
arm64 target does not use the x86 assembler. The included loader-path patch changes the macOS shared
library's install name; Cold Open does not add a native patch.

For a full native build, follow the versioned Electron build instructions
and DEPS files to obtain the remaining toolchain and separate dependency
checkouts and apply the full Electron patch set. The archives preserve the
reviewed library sources and Chromium's own build scripts. They are not an
offline bundle of macOS SDKs, compilers or every dependency needed to build
all of Electron. Those tools are not required to build Cold Open's JavaScript
against the supplied, unmodified Electron runtime.

The Chromium archive retains its upstream LICENSE and component-specific
licenses. Opus retains its own license and patent notices. These upstream
source archives are not relicensed as Cold Open GPL-only code.

The library in the app is at
`Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib`.
Cold Open imposes no additional restriction on modifying or replacing it or
reverse engineering for debugging those modifications. A modified macOS app
may need local signing before it can run. The GPL and LGPL rights remain in
force. The runtime notice file contains the applicable license texts.

Electron's `proprietary_codecs = true` flag selects codec support; it does not
by itself mean that FFmpeg's source has a proprietary software license. This
release does not make a separate codec patent clearance claim.

Versioned evidence:

- https://github.com/electron/electron/blob/v44.2.0/DEPS
- https://github.com/electron/electron/blob/v44.2.0/build/args/release.gn
- https://github.com/electron/electron/blob/v44.2.0/build/args/all.gn
- https://github.com/electron/electron/tree/v44.2.0/patches/ffmpeg
- https://github.com/chromium/chromium/blob/152.0.7977.76/DEPS
- https://github.com/chromium/chromium/blob/152.0.7977.76/third_party/opus/README.chromium
- https://www.ffmpeg.org/legal.html

These source records identify the supplied native components. This task did
not rebuild Chromium/Electron or verify byte-for-byte native reproducibility.
