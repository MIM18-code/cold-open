// Check a prepared release before publishing: notices in the app and the source snapshot, no private material,
// Developer ID signatures, notarization tickets, the source manifest and the native source archives. Writes SHA256SUMS.
import { verifyParakeet } from "../apps/desktop/scripts/parakeet-resources.mjs";
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { nativeSources, verifyNativeSource, sha256File } from './prepare-native-source.mjs';

const root = resolve(import.meta.dirname, '..');
// Private titles, accounts and links live in scripts/private-text.json, which the public source never contains.
// A build from the public source has nothing private to look for and skips that part of the check.
const privateFile = join(root, 'scripts/private-text.json');
export const privateText = existsSync(privateFile)
  ? new RegExp(JSON.parse(readFileSync(privateFile, 'utf8')).patterns.join('|')) : null;
// Binary formats a text search can't meaningfully read.
const BINARY = /\.(png|jpe?g|gif|icns|ico|webp|wasm|dylib|node|metallib|mlmodelc|bin|flac|zip|gz)$/i;

function files(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((item) => {
    const path = join(folder, item.name);
    assert.ok(!item.isSymbolicLink(), `Unexpected symlink ${path}`);
    return item.isDirectory() ? files(path) : [path];
  });
}

export function checkContents(tree) {
  for (const path of files(tree)) {
    const rel = relative(tree, path);
    assert.ok(!rel.split('/').some((part) => ['.git', 'node_modules', '.build', 'bench'].includes(part)), `Excluded directory in ${path}`);
    assert.ok(!/\.(fdx|fountain|screenplay)$/i.test(rel) || /\/test\/fixtures\//.test(rel) || /^apps\/desktop\/scripts\/fixtures\/basic\/edge\.(fdx|fountain)$/.test(rel), `Script file outside test fixtures: ${path}`);
    if (!privateText || BINARY.test(rel)) continue;
    assert.ok(!privateText.test(readFileSync(path, 'latin1')), `Private text in ${path}`);
  }
}

function verifySignature(bundle) {
  const result = spawnSync('codesign', ['--verify', '--deep', '--strict', bundle], { encoding: 'utf8' });
  assert.equal(result.status, 0, `codesign --verify --deep --strict failed for ${bundle}: ${result.stderr.trim()}`);
}

// A public release must be Developer ID signed, hardened, notarized and stapled, so Gatekeeper opens it with no warning.
function verifyNotarized(path, kind) {
  const info = spawnSync('codesign', ['-dvv', path], { encoding: 'utf8' }).stderr;
  assert.match(info, /Authority=Developer ID Application: /, `${path} is not signed with a Developer ID Application certificate`);
  if (kind === 'exec') assert.match(info, /flags=0x[0-9a-f]*\(runtime\)/, `${path} lacks the hardened runtime`);
  const args = kind === 'exec' ? ['-a', '-vv', '-t', 'exec', path] : ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', path];
  const assess = spawnSync('spctl', args, { encoding: 'utf8' });
  assert.equal(assess.status, 0, `Gatekeeper rejects ${path}: ${assess.stderr.trim()}`);
  assert.match(assess.stderr, /source=Notarized Developer ID/, `${path} is not notarized: ${assess.stderr.trim()}`);
  const staple = spawnSync('xcrun', ['stapler', 'validate', path], { encoding: 'utf8' });
  assert.equal(staple.status, 0, `No stapled ticket on ${path}: ${staple.stdout.trim()}`);
}

function checkNotices(tree) {
  for (const name of ['LICENSE', 'COPYRIGHT', 'THIRD_PARTY_NOTICES.md', 'licenses/electron-LICENSE', 'licenses/electron-LICENSES.chromium.html', 'licenses/components.json']) {
    assert.ok(existsSync(join(tree, name)), `Missing ${join(tree, name)}`);
  }
  const components = JSON.parse(readFileSync(join(tree, 'licenses/components.json')));
  for (const name of ['react', 'react-dom', 'prosemirror-view', 'yjs', '@screenplay/engine', 'fluidaudio', 'mlx-swift']) {
    const component = components.packages.find((entry) => entry.name === name);
    assert.ok(component, `Missing component notice for ${name}`);
    for (const file of component.files) assert.ok(existsSync(join(tree, 'licenses', file)), `Missing license file ${file}`);
  }
}

/** The packaged app: its version, its notices and no private text in anything it carries. */
async function checkApp(bundle, version) {
  const resources = join(bundle, 'Contents/Resources');
  for (const name of ['speech-helper', 'voice-helper/voice-helper', 'voice-helper/mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib']) {
    assert.ok(existsSync(join(resources, name)), `Missing bundled speech resource: ${name}`);
  }
  await verifyParakeet(join(resources, 'parakeet-tdt-0.6b-v3'));
  const unpacked = mkdtempSync(join(tmpdir(), 'coldopen-asar-'));
  try {
    const extract = spawnSync(join(root, 'node_modules/.bin/asar'), ['extract', join(bundle, 'Contents/Resources/app.asar'), unpacked], { encoding: 'utf8' });
    assert.equal(extract.status, 0, `Cannot read ${bundle}'s app.asar: ${extract.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(unpacked, 'package.json'))).version, version, `${bundle} is not version ${version}`);
    checkNotices(unpacked);
    checkContents(unpacked);
    checkContents(join(bundle, 'Contents/Resources'));
  } finally { rmSync(unpacked, { recursive: true, force: true }); }
}

async function verifyRelease() {
  if (!privateText) console.warn('scripts/private-text.json is absent, so no private-text check runs (expected for builds from the public source).');
  const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'))).version;
  const release = join(root, 'release/public');
  const source = join(release, `ColdOpen-${version}-source`);
  const appBundle = join(root, 'apps/desktop/release/mac-arm64/Cold Open.app');
  const dmg = join(release, `ColdOpen-${version}.dmg`);

  checkNotices(source);
  checkContents(source);
  for (const item of JSON.parse(readFileSync(join(source, 'SOURCE_MANIFEST.json')))) {
    assert.equal(createHash('sha256').update(readFileSync(join(source, item.path))).digest('hex'), item.sha256, item.path);
  }
  for (const name of ['docs/NATIVE_SOURCE.md', 'docs/OPTIONAL_DOWNLOADS.md', 'apps/desktop/src/renderer/features/assistant/brand/README.md', 'apps/desktop/scripts/test-packaged-basic.mjs', 'apps/desktop/scripts/fixtures/basic/edge.fdx', 'apps/desktop/scripts/fixtures/basic/edge.fountain', 'apps/desktop/scripts/fixtures/basic/jfk.flac', 'apps/desktop/scripts/fixtures/basic/speech-LICENSE.txt', 'apps/desktop/scripts/fixtures/basic/SOURCE.txt']) {
    assert.ok(existsSync(join(source, name)), `Missing ${name} in the source snapshot`);
  }
  await checkApp(appBundle, version);
  verifySignature(appBundle);
  verifyNotarized(appBundle, 'exec');
  verifyNotarized(dmg, 'open');

  // Check what is actually published: the app inside the DMG and the files inside the source tarball.
  const mount = mkdtempSync(join(tmpdir(), 'coldopen-dmg-'));
  assert.equal(spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]).status, 0, 'Cannot mount the release DMG');
  try {
    const shipped = join(mount, 'Cold Open.app');
    verifySignature(shipped);
    verifyNotarized(shipped, 'exec');
    await checkApp(shipped, version);
  } finally { spawnSync('hdiutil', ['detach', mount, '-quiet']); rmSync(mount, { recursive: true, force: true }); }
  const extracted = mkdtempSync(join(tmpdir(), 'coldopen-src-'));
  try {
    assert.equal(spawnSync('/usr/bin/tar', ['-xzf', join(release, `ColdOpen-${version}-source.tar.gz`), '-C', extracted]).status, 0, 'Cannot extract the source tarball');
    const tree = join(extracted, `ColdOpen-${version}-source`);
    const manifest = JSON.parse(readFileSync(join(tree, 'SOURCE_MANIFEST.json')));
    assert.deepEqual(manifest, JSON.parse(readFileSync(join(source, 'SOURCE_MANIFEST.json'))), 'The source tarball differs from the checked snapshot');
    for (const item of manifest) assert.equal(createHash('sha256').update(readFileSync(join(tree, item.path))).digest('hex'), item.sha256, `tarball ${item.path}`);
    assert.equal(files(tree).length, manifest.length + 1, 'The source tarball holds files outside its manifest');
    checkContents(tree);
    assert.equal(JSON.parse(readFileSync(join(tree, 'apps/desktop/package.json'))).version, version, 'The source tarball is for another version');
  } finally { rmSync(extracted, { recursive: true, force: true }); }

  await verifyNativeSource(release);
  const archives = [`ColdOpen-${version}.dmg`, `ColdOpen-${version}-source.tar.gz`, ...nativeSources.map((s) => s.file)];
  const checksums = (await Promise.all(archives.map(async (file) => `${await sha256File(join(release, file))}  ${file}`))).join('\n') + '\n';
  writeFileSync(join(release, 'SHA256SUMS'), checksums);
  console.log('Notices, contents and versions of the app, the DMG and the source tarball; Developer ID signatures, notarization tickets and native sources verified. SHA256SUMS written.');
}
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) await verifyRelease();
