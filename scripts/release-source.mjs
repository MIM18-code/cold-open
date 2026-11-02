// Prepare the public source snapshot that accompanies each release, and that seeds the public repository: the app,
// packages, helpers, tests and required notices, with no Git history, internal planning notes or build output.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepareLicenses } from './prepare-licenses.mjs';
import { prepareNativeSource, nativeSources } from './prepare-native-source.mjs';

const root = resolve(import.meta.dirname, '..');
const PUBLIC_DOCS = ['NATIVE_SOURCE.md', 'OPTIONAL_DOWNLOADS.md', 'app-architecture.md', 'sync-protocol.md', 'templates.md', 'table-read.md'];

export function publicPath(path) {
  const parts = path.split('/');
  if (parts.some((part) => ['.git', 'node_modules', 'dist', 'release', '.build', 'test-results', 'playwright-report', '.claude', '__pycache__'].includes(part))) return false;
  if (/\.(tsbuildinfo|log)$/.test(path)) return false;
  if (/^(apps\/(desktop|mobile)|packages\/(engine|relay|dictation)|native\/(speech-helper|voice-helper)|licenses)\//.test(path)) return true;
  if (/^docs\/phone-remote\//.test(path)) return true;
  if (parts[0] === 'docs' && parts.length === 2) return PUBLIC_DOCS.includes(parts[1]);
  if (/^scripts\/(prepare-licenses|prepare-native-source|release-source|verify-release|homebrew-cask)\.mjs$|^scripts\/build-helpers\.sh$/.test(path)) return true;
  return ['LICENSE', 'COPYRIGHT', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', '.gitignore'].includes(path);
}

export function sourceVersion() {
  return JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'))).version;
}

export async function releaseSource() {
  const version = sourceVersion();
  const output = join(root, 'release/public');
  const name = `ColdOpen-${version}-source`;
  const stage = join(output, name);
  mkdirSync(output, { recursive: true });
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  // Only committed files are candidates: nothing untracked, ignored or local, and no Git metadata or history.
  const candidates = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
  for (const file of new Set(candidates)) {
    if (!publicPath(file) || !existsSync(join(root, file))) continue;
    const to = join(stage, file);
    mkdirSync(resolve(to, '..'), { recursive: true });
    cpSync(join(root, file), to, { dereference: false });
  }
  cpSync(join(root, 'docs/PUBLIC_README.md'), join(stage, 'README.md'));
  await prepareLicenses(stage);
  await prepareNativeSource(join(root, 'release/upstream-source'));
  for (const file of [...nativeSources.map((source) => source.file), 'sources.json']) {
    rmSync(join(output, file), { force: true });
    cpSync(join(root, 'release/upstream-source', file), join(output, file));
  }
  const inventory = [];
  const walk = (folder) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, item.name);
      if (item.isSymbolicLink()) throw new Error(`Source snapshot contains a symlink: ${path}`);
      if (item.isDirectory()) walk(path);
      else inventory.push({ path: relative(stage, path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    }
  };
  walk(stage);
  writeFileSync(join(stage, 'SOURCE_MANIFEST.json'), JSON.stringify(inventory, null, 2) + '\n');
  execFileSync('/usr/bin/tar', ['-czf', join(output, `${name}.tar.gz`), '-C', output, name]);
  const dmg = join(root, 'apps/desktop/release', `ColdOpen-${version}.dmg`);
  if (existsSync(dmg)) cpSync(dmg, join(output, `ColdOpen-${version}.dmg`));
  console.log(`Prepared ${stage}: internal notes, build output and Git history excluded.`);
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await releaseSource();
