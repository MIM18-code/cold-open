// The Electron, Chromium, FFmpeg and NASM sources that must accompany every binary release (docs/NATIVE_SOURCE.md).
// Same pins as Backlot, which ships the same Electron.
import { copyFileSync, linkSync, mkdirSync, readFileSync, writeFileSync, existsSync, createReadStream, createWriteStream, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(import.meta.dirname, '..');
const run = promisify(execFile);
export const nativeSources = [
  { file: 'electron-v44.2.0.tar.gz', url: 'https://codeload.github.com/electron/electron/tar.gz/refs/tags/v44.2.0', sha256: '2f09160dd4cce720dd11507a898350b44019ebd5623e7c42eb1d045daa8e046a', prefix: 'electron-44.2.0/', required: ['DEPS', 'build/args/release.gn', 'patches/ffmpeg/.patches', 'patches/ffmpeg/link_with_loader_path.patch'] },
  { file: 'ffmpeg-2b68d2babae73714846961fb0ee47e3b3d2e39a9.tar.gz', url: 'https://chromium.googlesource.com/chromium/third_party/ffmpeg/+archive/2b68d2babae73714846961fb0ee47e3b3d2e39a9.tar.gz', sha256: '871fa9a410946d0dda25004449cabec8030f5ced99d53b2ecb92a0d5e82fc104', prefix: '', required: ['BUILD.gn', 'COPYING.LGPLv2.1', 'libavcodec/libopus.c', 'chromium/config/Chrome/mac/arm64/config.h'] },
  { file: 'chromium-152.0.7977.76.tar.gz', url: 'https://codeload.github.com/chromium/chromium/tar.gz/refs/tags/152.0.7977.76', sha256: '2dc388258d14660a26e36646473f0fe894772456e8804152beb11adfc7b2f425', prefix: 'chromium-152.0.7977.76/', required: ['LICENSE', 'DEPS', '.gn', 'BUILD.gn', 'third_party/opus/README.chromium', 'third_party/opus/BUILD.gn', 'third_party/opus/src/COPYING', 'third_party/opus/src/src/opus_decoder.c', 'third_party/opus/src/include/opus.h', 'build/buildflag_header.gni', 'build/config/compiler/compiler.gni', 'build/config/sanitizers/sanitizers.gni', 'build/config/BUILDCONFIG.gn', 'build/config/arm.gni', 'tools/generate_stubs/generate_stubs.py'] },
  { file: 'nasm-525a09a813be0f75b646ee93fc2a31c27b87d722.tar.gz', url: 'https://chromium.googlesource.com/chromium/deps/nasm/+archive/525a09a813be0f75b646ee93fc2a31c27b87d722.tar.gz', sha256: 'df44b947163f174b96fbdb4ced46b780d9b1fbf049c422b1486482e564d9b833', prefix: '', required: ['LICENSE', 'BUILD.gn', 'nasm_assemble.gni'] },
];

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function checkArchiveMembers(source, members) {
  const paths = new Set(members);
  for (const required of source.required) {
    if (!paths.has(source.prefix + required)) throw new Error(`Native source missing ${source.file}: ${required}`);
  }
}

export async function verifyNativeSource(destination) {
  for (const source of nativeSources) {
    const path = join(destination, source.file);
    if (await sha256File(path) !== source.sha256) throw new Error(`Source checksum mismatch: ${source.file}`);
    const { stdout } = await run('/usr/bin/tar', ['-tzf', path], { maxBuffer: 128 * 1024 * 1024 });
    checkArchiveMembers(source, stdout.trimEnd().split('\n'));
  }
}

/** `cache` is a folder that may already hold verified archives (Backlot's dist/upstream-source), to skip a 1.5 GB download. */
export async function prepareNativeSource(destination, cache = process.env.NATIVE_SOURCE_CACHE) {
  const manifest = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json')));
  if (manifest.devDependencies.electron !== '44.2.0') throw new Error('Update native source pins when changing Electron');
  mkdirSync(destination, { recursive: true });
  for (const source of nativeSources) {
    const path = join(destination, source.file);
    // A hard link costs no disk on the same volume; the hash check below still verifies it.
    if (!existsSync(path) && cache && existsSync(join(cache, source.file))) {
      try { linkSync(join(cache, source.file), path); } catch { copyFileSync(join(cache, source.file), path); }
    }
    if (!existsSync(path)) {
      const temporary = path + '.part';
      try {
        const response = await fetch(source.url);
        if (!response.ok || !response.body) throw new Error(`Source download failed: ${source.url}: ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
        if (await sha256File(temporary) !== source.sha256) throw new Error(`Source checksum mismatch: ${source.file}`);
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
  }
  await verifyNativeSource(destination);
  writeFileSync(join(destination, 'sources.json'), JSON.stringify(nativeSources, null, 2) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  await prepareNativeSource(resolve(process.argv[2] ?? join(root, 'release/upstream-source')));
}
