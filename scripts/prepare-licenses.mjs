// Collect the license and notice files of everything the app bundles into <destination>/licenses: the JavaScript
// packages in the renderer and main bundles, the Swift packages compiled into the native helpers, and Electron's
// own license and Chromium notices. Fails when a bundled component has no license text.
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { downloadArtifact } from '@electron/get';

const root = resolve(import.meta.dirname, '..');
const NOTICE = /^(licen[cs]e|copying|copyright|notice|third.?party)/i;

function packageRoot(name, parent) {
  const require = createRequire(join(parent, 'package.json'));
  let path;
  try { path = dirname(require.resolve(`${name}/package.json`)); }
  catch { path = dirname(require.resolve(name)); }
  while (!existsSync(join(path, 'package.json')) || JSON.parse(readFileSync(join(path, 'package.json'))).name !== name) {
    const next = dirname(path);
    if (next === path) throw new Error(`Cannot find package root for ${name}`);
    path = next;
  }
  return realpathSync(path);
}

/** Notice files at any depth of a checkout, skipping Git data, tests, examples and benchmarks. */
function nestedNotices(base, rel = '') {
  const out = [];
  for (const item of readdirSync(join(base, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${item.name}` : item.name;
    if (item.isDirectory()) {
      // A folder named for notices (ThirdPartyLicenses, LICENSES) is kept whole.
      if (NOTICE.test(item.name)) out.push(path);
      else if (!/^(\.git|\.github|tests?|Tests|Examples?|examples?|Benchmarks?|benchmarks?|docs?)$/.test(item.name)) out.push(...nestedNotices(base, path));
    } else if (NOTICE.test(item.name) && !/\.(swift|h|hpp|c|cpp|m|mm|py|sh)$/i.test(item.name)) out.push(path);
  }
  return out;
}

export async function prepareLicenses(destination) {
  const folder = join(destination, 'licenses');
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const entries = [], seen = new Set();
  const keep = (id, from, files) => {
    const target = join(folder, id);
    mkdirSync(target, { recursive: true });
    // Written fresh rather than copied: SwiftPM checkouts are read-only, and copies would keep that mode. A notice
    // can be a folder (a LICENSES directory), copied file by file.
    const write = (src, dest) => {
      if (statSync(src).isDirectory()) { mkdirSync(dest, { recursive: true }); for (const name of readdirSync(src)) write(join(src, name), join(dest, name)); }
      else writeFileSync(dest, readFileSync(src));
    };
    for (const file of files) { mkdirSync(dirname(join(target, file)), { recursive: true }); write(join(from, file), join(target, file)); }
    return files.map((file) => `${id}/${file}`);
  };
  function visit(name, parent) {
    const path = packageRoot(name, parent);
    if (!path.startsWith(root + sep)) throw new Error(`Dependency outside the checkout: ${name}`);
    if (seen.has(path)) return;
    seen.add(path);
    const pkg = JSON.parse(readFileSync(join(path, 'package.json')));
    // The app itself is covered by the root LICENSE; its own workspace packages carry theirs like any upstream.
    if (name !== '@screenplay/desktop') {
      const id = `${name.replaceAll('/', '__')}@${pkg.version}`;
      const files = readdirSync(path).filter((file) => NOTICE.test(file));
      // saxes publishes no LICENSE in its npm package; licenses/<name>-LICENSE holds its upstream repository's text.
      const kept = join(root, 'licenses', `${name.replaceAll('/', '__')}-LICENSE`);
      if (!files.length && existsSync(kept)) {
        mkdirSync(join(folder, id), { recursive: true }); copyFileSync(kept, join(folder, id, 'LICENSE'));
        entries.push({ kind: 'npm', name, version: pkg.version, license: pkg.license, repository: pkg.repository, files: [`${id}/LICENSE`] });
      } else {
      if (!files.length) throw new Error(`Missing license text: ${id}`);
      entries.push({ kind: 'npm', name, version: pkg.version, license: pkg.license, repository: pkg.repository, files: keep(id, path, files) });
      }
    }
    for (const child of Object.keys(pkg.dependencies ?? {})) visit(child, path);
    for (const child of Object.keys(pkg.peerDependencies ?? {})) if (!pkg.peerDependenciesMeta?.[child]?.optional) visit(child, path);
  }
  visit('@screenplay/desktop', root);

  // Swift packages pinned in each helper's Package.resolved, read from the checkouts the release build compiled.
  for (const helper of ['speech-helper', 'voice-helper']) {
    const base = join(root, 'native', helper);
    const resolved = JSON.parse(readFileSync(join(base, 'Package.resolved')));
    const checkouts = join(base, '.build/checkouts');
    const dirs = existsSync(checkouts) ? readdirSync(checkouts) : [];
    for (const pin of resolved.pins ?? []) {
      const id = `swift__${pin.identity}@${pin.state?.version ?? pin.state?.revision?.slice(0, 12)}`;
      if (entries.some((entry) => entry.id === id)) continue;
      const dir = dirs.find((name) => name.toLowerCase() === pin.identity.toLowerCase());
      if (!dir) throw new Error(`Swift checkout missing for ${pin.identity}; run swift build -c release in native/${helper}`);
      // Nested notices too: MLX Swift compiles MLX, metal-cpp, fmt and a JSON library, each with its own license.
      const files = nestedNotices(join(checkouts, dir));
      if (!files.length) throw new Error(`Missing license text: ${id}`);
      entries.push({ kind: 'swift', id, name: pin.identity, version: pin.state?.version, revision: pin.state?.revision, repository: pin.location,
        files: keep(id, join(checkouts, dir), files) });
    }
  }

  const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'))).devDependencies.electron;
  const archive = await downloadArtifact({ version, artifactName: 'electron', platform: 'darwin', arch: 'arm64' });
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    const data = execFileSync('/usr/bin/unzip', ['-p', archive, name], { maxBuffer: 64 * 1024 * 1024 });
    if (!data.length) throw new Error(`Electron archive lacks ${name}`);
    writeFileSync(join(folder, `electron-${name}`), data);
  }
  writeFileSync(join(folder, 'components.json'), JSON.stringify({ electron: version, packages: entries }, null, 2) + '\n');
  writeFileSync(join(folder, 'README.md'), '# Third-party software licenses\n\nElectron and Chromium notices are in electron-LICENSE and electron-LICENSES.chromium.html. JavaScript and Swift package notices are in the named folders; components.json records each version, license and upstream source.\n');
  return entries;
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const entries = await prepareLicenses(resolve(process.argv[2] ?? join(root, 'release/licenses-stage')));
  console.log(`Collected ${entries.length} component notices.`);
}
