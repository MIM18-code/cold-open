// Exercises the packaged app with fictional scripts and an attributed speech test fixture.
// Native file pickers and the exact CJK system-font confirmation receive test responses;
// no PDF rendering or other app functionality is mocked.
// Run after packaging: node apps/desktop/scripts/test-packaged-basic.mjs [--full] [path/to/Cold Open.app]
//
// Playwright attaches through --inspect, which a release build's fuses turn off (fuses.mjs). So package.mjs runs
// this with --full on the assembled app before it sets that fuse, and a sealed app gets the bundled-speech check
// and the checks that need no debugger: it starts, ignores injected code, quits cleanly, and refuses to start
// with Chromium's page debugger switched on.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer } from 'node:net';
import { _electron as electron } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { fuseProblems, readFuses } from './fuses.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const full = process.argv.includes('--full');
const appPath = resolve(process.argv.slice(2).find(arg => arg !== '--full') ?? join(here, '../release/mac-arm64/Cold Open.app'));
const resources = join(appPath, 'Contents/Resources');
const binary = join(appPath, 'Contents/MacOS/Cold Open');
const expectedVersion = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).version;
const helper = join(resources, 'speech-helper');
const model = join(resources, 'parakeet-tdt-0.6b-v3');
const fixtures = join(here, 'fixtures/basic');
const root = mkdtempSync(join(tmpdir(), 'cold-open-packaged-basic-'));
const home = join(root, 'home');
mkdirSync(join(home, 'Documents'), { recursive: true });
mkdirSync(join(root, 'tmp'));
const env = { HOME: home, TMPDIR: join(root, 'tmp'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
const sha = data => createHash('sha256').update(data).digest('hex');
const check = (value, message) => assert.ok(value, message);
const output = name => join(root, name);
const fileText = path => readFileSync(path, 'utf8');
const pdfText = path => {
  // PDFKit ships with macOS. Pass the path as an argument, not interpolated script text.
  const script = 'ObjC.import("PDFKit"); function run(args) { const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(args[0])); return d && d.string ? d.string.js : ""; }';
  const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, path], { env, encoding: 'utf8', timeout: 30000 });
  check(result.status === 0, `PDFKit extraction failed: ${result.error ?? result.stderr}`);
  return result.stdout;
};

// A profile whose settings start local AI at launch, with a script planted where the app keeps its own Ollama
// download. A signed release must skip it (src/main/trusted-program.ts); an unsigned build runs it as before. With
// `link`, the planted ollama is a symlink to a script elsewhere in the profile, so the check follows it and still
// refuses. A symlink to a path under /System/Volumes/Data once passed as a system program that way.
const ollamaVersion = /const VERSION = "([^"]+)"/.exec(fileText(join(here, '../src/main/models/local-runtime.ts')))[1];
const plantOllama = (profile, link = false) => {
  const folder = join(output(profile), 'local-ai', `ollama-${ollamaVersion}`), marker = output(`${profile}-ran`);
  mkdirSync(folder, { recursive: true });
  const script = link ? join(output(profile), 'elsewhere', 'ollama') : join(folder, 'ollama');
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  if (link) symlinkSync(script, join(folder, 'ollama'));
  writeFileSync(join(output(profile), 'settings.json'), JSON.stringify({ 'grants.startLocalAI': true }));
  return marker;
};
// The app starts no Ollama when one already answers, so the planted script would not run either way.
const ollamaAnswers = () => fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const OLLAMA_SKIP = 'SKIP planted Ollama check: a server already answers on 127.0.0.1:11434. Quit Ollama to run it.';

function verifyModelAndInference() {
  check(existsSync(binary) && existsSync(helper), `Packaged app or speech helper is missing: ${appPath}`);
  const manifest = JSON.parse(fileText(join(here, 'parakeet-files.json')));
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = join(model, name);
    check(existsSync(path), `Bundled Parakeet file missing: ${name}`);
    assert.equal(sha(readFileSync(path)), expected, `Bundled Parakeet checksum mismatch: ${name}`);
  }
  // Swift resolves Application Support independently of HOME. Deny the real user's FluidAudio
  // cache and all network access in this child only; no files or OS permissions are changed.
  const cache = join(userInfo().homedir, 'Library/Application Support/FluidAudio');
  const paths = [...new Set([cache, existsSync(cache) ? realpathSync(cache) : cache])];
  const sbString = s => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const profile = `(version 1)\n(allow default)\n(deny network*)\n${paths.map(p => `(deny file-read* (subpath ${sbString(p)}))`).join('\n')}\n`;
  const run = exe => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, exe, 'transcribe', '--engine', 'parakeet', join(fixtures, 'jfk.flac')], { env, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  // A helper with no model next to it must fail. This control proves the cache denial actually matters.
  const isolated = output('speech-helper-without-model');
  copyFileSync(helper, isolated);
  const negative = run(isolated);
  check(!negative.error, `No-model control could not run: ${negative.error}`);
  check(negative.status !== 0 && /weights are not downloaded/i.test(negative.stdout + negative.stderr), `No-model control did not reject cached weights: ${negative.stdout} ${negative.stderr}`);
  const positive = run(helper);
  check(!positive.error && positive.status === 0, `Bundled Parakeet inference failed: ${positive.error ?? ''} ${positive.stdout} ${positive.stderr}`);
  const rows = positive.stdout.trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  check(rows.some(row => row.event === 'loaded' && row.engine === 'parakeet-coreml-int8-v2'), 'Bundled Parakeet did not load');
  const transcript = rows.find(row => typeof row.text === 'string');
  check(transcript && /fellow\s+americans/i.test(transcript.text) && /country/i.test(transcript.text), `Speech fixture transcription did not contain expected words: ${JSON.stringify(rows)}`);
  console.log('PASS bundled Parakeet checksums and offline licensed speech fixture, with user cache denied');
}

/** The sealed app, with nothing attached: it opens its window, ignores the three ways another program could push
 * code into its main process, quits when asked, and refuses to start with Chromium's page debugger switched on. */
async function sealedChecks() {
  // Read the fuses too: a packaged app drops --require from NODE_OPTIONS whatever that fuse says, so the launch
  // below cannot tell whether it is set.
  assert.deepEqual(await fuseProblems(appPath), [], 'The sealed app has the wrong Electron fuses');
  const sleep = ms => new Promise(done => setTimeout(done, ms));
  const freePort = () => new Promise(done => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); }); });
  // SCREENPLAY_E2E keeps the window and the Dock icon hidden. It must not relax any of these checks.
  const start = (profile, args, extraEnv = {}, extraStdio = []) => {
    const child = spawn(binary, [`--user-data-dir=${output(profile)}`, ...args],
      { env: { ...env, SCREENPLAY_E2E: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe', ...extraStdio] });
    const run = { child, log: '', exit: undefined };
    child.stdout.on('data', data => { run.log += data; }); child.stderr.on('data', data => { run.log += data; });
    run.exited = new Promise(done => child.on('exit', (code, signal) => { run.exit = { code, signal }; done(); }));
    run.describe = () => `${JSON.stringify(run.exit)} ${run.log}`;
    return run;
  };

  const port = await freePort();
  // Ask the port for a debugger's target list, so another program that happens to take the port is not mistaken for one.
  const debuggerOn = () => fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
    .then(async response => /webSocketDebuggerUrl/.test(await response.text()), () => false);
  const marker = output('injected'), hook = output('hook.cjs');
  writeFileSync(hook, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");`);
  const app = start('sealed-profile', [`--inspect=${port}`], { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: `--require=${hook}` });
  // A renderer process under this app means it started as the app and made its window.
  const rendering = (run = app) => spawnSync('/bin/ps', ['-axo', 'ppid=,command='], { encoding: 'utf8' }).stdout.split('\n')
    .some(line => line.trim().startsWith(`${run.child.pid} `) && line.includes('Helper (Renderer)'));
  try {
    for (let i = 0; i < 120 && !app.exit && !rendering(); i++) await sleep(250);
    check(!app.exit && rendering(), `The sealed app did not open its window: ${app.describe()}`);
    await sleep(3000);
    check(!app.exit, `The sealed app quit on its own: ${app.describe()}`);
    check(!existsSync(marker), 'ELECTRON_RUN_AS_NODE or NODE_OPTIONS ran code in the sealed app');
    check(!/Debugger listening/.test(app.log) && !(await debuggerOn()), `--inspect opened a debugger port in the sealed app: ${app.log}`);
    app.child.kill('SIGTERM');
    await Promise.race([app.exited, sleep(15000)]);
    check(app.exit?.code === 0, `The sealed app did not quit cleanly: ${app.describe()}`);
  } finally { if (!app.exit) app.child.kill('SIGKILL'); }
  console.log('PASS sealed app has the release fuses, opens hidden, ignores ELECTRON_RUN_AS_NODE, NODE_OPTIONS and --inspect, quits cleanly');

  // SCREENPLAY_DEV_URL is for `npm run dev`. If a packaged app honoured it, the launching program's page would get the
  // service bridge and the microphone grant. Any request to this server, even for a favicon, fails the check.
  const requests = [];
  const devServer = createHttpServer((request, response) => { requests.push(request.url); response.end('<!doctype html><title>not Cold Open</title>'); });
  await new Promise(done => devServer.listen(0, '127.0.0.1', done));
  const devApp = start('dev-url-profile', [], { SCREENPLAY_DEV_URL: `http://127.0.0.1:${devServer.address().port}` });
  try {
    for (let i = 0; i < 120 && !devApp.exit && !rendering(devApp); i++) await sleep(250);
    check(!devApp.exit && rendering(devApp), `The sealed app did not open its window with SCREENPLAY_DEV_URL set: ${devApp.describe()}`);
    await sleep(3000);
    check(!devApp.exit, `The sealed app quit on its own with SCREENPLAY_DEV_URL set: ${devApp.describe()}`);
    assert.deepEqual(requests, [], 'The sealed app loaded SCREENPLAY_DEV_URL instead of its own page');
    devApp.child.kill('SIGTERM');
    await Promise.race([devApp.exited, sleep(15000)]);
    check(devApp.exit?.code === 0, `The sealed app did not quit cleanly with SCREENPLAY_DEV_URL set: ${devApp.describe()}`);
  } finally { if (!devApp.exit) devApp.child.kill('SIGKILL'); devServer.close(); }
  console.log('PASS sealed app ignores SCREENPLAY_DEV_URL: the address it named got no request');

  // Chromium's own debugger switches reach the page, and no fuse covers them. The app must quit instead
  // (src/main/page-debugger.ts) without the debugger ever answering. Both launches are watched from the first
  // moment, so a debugger that opens briefly before the app quits fails the check.
  const pagePort = await freePort();
  const accepts = () => new Promise(done => { const socket = connect(pagePort, '127.0.0.1'); socket.on('connect', () => { socket.destroy(); done(true); }); socket.on('error', () => done(false)); });
  const byPort = start('page-port-profile', [`--remote-debugging-port=${pagePort}`]);
  try {
    let accepted = false;
    for (const until = Date.now() + 20000; !byPort.exit && !accepted && Date.now() < until;) { accepted = await accepts(); await new Promise(setImmediate); }
    for (let i = 0; i < 50 && !accepted; i++) { accepted = await accepts(); await sleep(10); }
    check(!accepted && !/DevTools listening/.test(byPort.log), `--remote-debugging-port opened the page to a debugger in the sealed app: ${byPort.describe()}`);
    check(byPort.exit?.code === 1, `The sealed app did not refuse --remote-debugging-port: ${byPort.describe()}`);
  } finally { if (!byPort.exit) byPort.child.kill('SIGKILL'); }

  // The pipe form talks over file descriptors 3 and 4: null-terminated JSON in, answers out.
  const byPipe = start('page-pipe-profile', ['--remote-debugging-pipe'], {}, ['pipe', 'pipe']);
  const [, , , toApp, fromApp] = byPipe.child.stdio;
  let answer = '';
  fromApp.on('data', data => { answer += data; });
  toApp.on('error', () => {});
  const asking = setInterval(() => { if (toApp.writable) toApp.write('{"id":1,"method":"Browser.getVersion"}\0'); }, 20);
  try {
    await Promise.race([byPipe.exited, sleep(20000)]);
    await sleep(500);
    check(!answer, `--remote-debugging-pipe opened the page to a debugger in the sealed app: ${answer.slice(0, 200)}`);
    check(byPipe.exit?.code === 1, `The sealed app did not refuse --remote-debugging-pipe: ${byPipe.describe()}`);
  } finally { clearInterval(asking); if (!byPipe.exit) byPipe.child.kill('SIGKILL'); }
  console.log('PASS sealed app quits before --remote-debugging-port or --remote-debugging-pipe can reach its page');

  if (await ollamaAnswers()) console.log(OLLAMA_SKIP);
  else {
    for (const [profile, link] of [['ollama-profile', false], ['ollama-link-profile', true]]) {
      const marker = plantOllama(profile, link);
      const planted = start(profile, []);
      try {
        for (let i = 0; i < 120 && !planted.exit && !rendering(planted); i++) await sleep(250);
        check(!planted.exit && rendering(planted), `The sealed app did not open its window with local AI set to start: ${planted.describe()}`);
        await sleep(5000);
        check(!existsSync(marker), `The sealed app ran an unsigned program planted at local-ai/ollama-*/ollama in its profile${link ? ' through a symlink' : ''}`);
        planted.child.kill('SIGTERM');
        await Promise.race([planted.exited, sleep(15000)]);
        check(planted.exit?.code === 0, `The sealed app did not quit cleanly with local AI set to start: ${planted.describe()}`);
      } finally { if (!planted.exit) planted.child.kill('SIGKILL'); }
    }
    console.log('PASS sealed app skips an unsigned Ollama planted in its profile, directly or through a symlink');
  }
}

async function main() {
  const launch = (profile, path, extraEnv = {}) => electron.launch({ executablePath: binary, args: [`--user-data-dir=${output(profile)}`, ...(path ? [path] : [])], env: { ...env, ...extraEnv } });
  let app;
  const open = async (profile, path, extraEnv) => { app = await launch(profile, path, extraEnv); assert.equal(await app.evaluate(({ app }) => app.getVersion()), expectedVersion, 'Packaged app version differs from package.json'); const p = await app.firstWindow(); await p.locator('.editor-pm').waitFor(); return p; };
  const close = async () => { if (app) { await app.close(); app = undefined; } };
  const command = async (p, name) => { await p.getByRole('button', { name: /^Commands/ }).click(); await p.getByText(name, { exact: false }).first().click(); };
  const saveDialog = async path => app.evaluate(({ dialog }, target) => { globalThis.__testSaveDialogCalls = 0; dialog.showSaveDialog = async () => { globalThis.__testSaveDialogCalls++; return target ? { canceled: false, filePath: target } : { canceled: true }; }; }, path);
  const openDialog = async path => app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, path);
  const waitFile = async path => {
    let previous = -1, unchanged = 0;
    for (let i = 0; i < 150; i++) {
      const size = existsSync(path) ? statSync(path).size : 0;
      unchanged = size > 0 && size === previous ? unchanged + 1 : 0;
      if (unchanged >= 2) return;
      previous = size;
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`Output was not complete and stable: ${basename(path)}`);
  };
  const exportFile = async (p, label, path) => {
    await saveDialog(path); await command(p, label);
    await p.waitForTimeout(500);
    const initialState = await p.locator('body').innerText();
    const pickerCalls = await app.evaluate(() => globalThis.__testSaveDialogCalls);
    try { await waitFile(path); }
    catch (error) {
      writeFileSync(output('export-failure.txt'), `PICKER CALLS: ${pickerCalls}\nINITIAL:\n${initialState}\nLATER:\n${await p.locator('body').innerText()}`);
      await p.screenshot({ path: output('export-failure.png') });
      throw error;
    }
  };
  try {
    let p = await open('new-profile');
    await p.locator('.editor-pm').click();
    await p.keyboard.insertText('INT. LANTERN ROOM - NIGHT');
    await p.keyboard.press('Enter'); await p.keyboard.insertText('A lantern flickers beside the door.');
    await saveDialog(null); await command(p, 'File ›Save As');
    await p.getByText('Unsaved', { exact: true }).waitFor();
    check((await p.locator('.editor-pm').innerText()).includes('A lantern flickers'), 'Cancel lost the unsaved draft');
    const native = output('Lantern.screenplay');
    await exportFile(p, 'File ›Save As', native);
    await p.waitForFunction(() => window.__app.session.dirty === false);
    assert.equal(readFileSync(native).subarray(0, 8).toString(), 'SCRNPLY1');
    await close();
    p = await open('new-profile', native);
    await p.getByText('A lantern flickers beside the door.', { exact: false }).first().waitFor();
    await command(p, 'Tools ›Reports');
    const report = output('report.csv'); await saveDialog(report);
    await p.getByRole('button', { name: 'Export CSV…' }).click(); await waitFile(report);
    check(fileText(report).includes('Character'), 'Report CSV missing its header');
    await p.keyboard.press('Escape'); await p.evaluate(() => window.__app.closeModal());
    await close();
    console.log('PASS new, cancelled save, native save and reopen, report export');

    const fdxInput = output('edge.fdx'); copyFileSync(join(fixtures, 'edge.fdx'), fdxInput);
    const originalHash = sha(readFileSync(fdxInput));
    p = await open('fdx-profile', fdxInput);
    await p.getByText('Right voice.', { exact: false }).first().waitFor();
    const html = await p.locator('.editor-pm').innerHTML();
    for (const piece of ['李', '<strong>Bold</strong>', '<em> Italic</em>', '<u> Underline</u>', 'editor-dual', 'data-scene-number="12A"']) check(html.includes(piece), `FDX import missing ${piece}`);
    const outFdx = output('roundtrip.fdx'); await exportFile(p, 'File ›Export Final Draft', outFdx);
    const xml = fileText(outFdx);
    for (const piece of ['李', '&amp;', '&lt;the key&gt;', 'Style="Bold"', 'Style="Italic"', 'Style="Underline"', 'TagNumber="1"', '<TagData>', '<DualDialogue>', 'RevisionID="1"', 'Number="12A"', 'THE FERRY TEST', 'CustomFixtureData']) check(xml.includes(piece), `FDX export missing ${piece}`);
    assert.equal(sha(readFileSync(fdxInput)), originalHash, 'Import/export changed original FDX');
    await command(p, 'File ›Export Sides');
    await p.locator('[role=dialog] input[type=checkbox]').first().check();
    const sides = output('sides.fdx'); await saveDialog(sides); await p.getByRole('button', { name: 'Export…', exact: true }).click(); await waitFile(sides);
    const sx = fileText(sides);
    for (const piece of ['Number="12A"', 'THE FERRY TEST', '<DualDialogue>']) check(sx.includes(piece), `Sides missing ${piece}`);
    check(!sx.includes('EXT. HARBOR - DAY'), 'Sides include the unselected scene');
    await close();
    const invalid = output('invalid.screenplay'); writeFileSync(invalid, 'not a screenplay\0\xff'); const badHash = sha(readFileSync(invalid));
    p = await open('invalid-profile');
    await openDialog(invalid); await command(p, 'File ›Open…');
    await p.getByText('This is not a screenplay file.', { exact: false }).waitFor({ timeout: 10000 });
    assert.equal(sha(readFileSync(invalid)), badHash, 'Failed open changed invalid input');
    check((await p.locator('body').innerText()).includes('Untitled'), 'Failed open replaced the blank document');
    await close();
    console.log('PASS FDX features, selected sides, invalid-file recovery');

    p = await open('fountain-profile', join(fixtures, 'edge.fountain'));
    await p.getByText('Hello & goodbye.', { exact: false }).first().waitFor();
    check((await p.locator('.editor-pm').innerHTML()).includes('editor-note'), 'Fountain note did not import');
    const ftn = output('roundtrip.fountain'); await exportFile(p, 'File ›Export Fountain', ftn);
    for (const piece of ['.The odd forced place', '[[An editor note: take the wide shot.]]', '#12A#', 'Hello & goodbye.']) check(fileText(ftn).includes(piece), `Fountain export missing ${piece}`);
    await close();
    console.log('PASS Fountain forced heading, note, scene number and export');

    const multi = output('multipage.fountain');
    let script = 'Title: Multi Page Proof\n\n';
    for (let i = 1; i <= 44; i++) script += `INT. TEST ROOM ${i} - DAY\n\nSCENE ${i} START. The quick brown fox jumps over the lazy dog. This paragraph checks printed layout and scene order. SCENE ${i} END.\n\nMARA\nLine ${i} has accented café and symbols.\n\n`;
    writeFileSync(multi, script);
    p = await open('pdf-profile', multi); await p.getByText('SCENE 44 START.', { exact: false }).first().waitFor(); await p.context().setOffline(true);
    const pdf = output('multipage.pdf'); await exportFile(p, 'File ›Export PDF', pdf);
    const doc = await PDFDocument.load(readFileSync(pdf)); check(doc.getPageCount() >= 3, 'PDF should have multiple pages');
    const printed = pdfText(pdf).replace(/\s+/g, " ");
    for (let i = 1; i <= 44; i++) for (const marker of [`SCENE ${i} START`, `SCENE ${i} END`, `Line ${i} has`]) check(printed.includes(marker), `PDF missing ${marker}`);
    await close();
    p = await open('unicode-profile', fdxInput);
    await p.getByText('Right voice.', { exact: false }).first().waitFor();
    // The real app explicitly asks before using system fonts. Supply only this exact
    // expected response; any other native message is a test failure, never autoaccepted.
    await app.evaluate(({ dialog }) => {
      globalThis.__testFontConfirmCount = 0;
      globalThis.__testOriginalMessageBox = dialog.showMessageBox;
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        if (options?.message !== 'Use system-font PDF rendering for this draft?' ||
            JSON.stringify(options?.buttons) !== JSON.stringify(['Use system fonts', 'Cancel'])) {
          throw new Error(`Unexpected native confirmation: ${JSON.stringify(options)}`);
        }
        globalThis.__testFontConfirmCount++;
        return { response: 0, checkboxChecked: false };
      };
    });
    const unicodePdf = output('unicode.pdf'); await exportFile(p, 'File ›Export PDF', unicodePdf);
    assert.equal(await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = globalThis.__testOriginalMessageBox;
      return globalThis.__testFontConfirmCount;
    }), 1, 'Expected exactly one system-font confirmation');
    check((await PDFDocument.load(readFileSync(unicodePdf))).getPageCount() >= 1, 'Unicode PDF did not open');
    for (const piece of ['CAFÉ', 'Zoë', '李', 'Left voice.', 'Right voice.']) check(pdfText(unicodePdf).includes(piece), `Unicode PDF missing ${piece}`);
    await close();
    console.log('PASS multipage and CJK PDF text, with expected system-font confirmation supplied');

    // A packaged app runs its own speech helper, never one the launching program names. The status call resolves the
    // path without running it.
    const planted = output('planted-speech-helper');
    writeFileSync(planted, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    p = await open('helper-env-profile', undefined, { SCREENPLAY_SPEECH_HELPER: planted });
    const status = await p.evaluate(() => window.desktop.invoke('dictation:status'));
    assert.equal(status.helperPath, helper, 'The packaged app chose the speech helper named by SCREENPLAY_SPEECH_HELPER');
    await close();
    console.log('PASS packaged app ignores SCREENPLAY_SPEECH_HELPER');

    // The control for the sealed check: this ad hoc build is not sealed, so it runs the planted Ollama as before.
    if (await ollamaAnswers()) console.log(OLLAMA_SKIP);
    else {
      const ran = plantOllama('ollama-profile');
      p = await open('ollama-profile');
      for (let i = 0; i < 40 && !existsSync(ran); i++) await new Promise(r => setTimeout(r, 250));
      check(existsSync(ran), 'The unsealed packaged app did not start local AI from its profile, so the sealed check proves nothing');
      await close();
      console.log('PASS unsealed packaged app still starts the Ollama in its profile');
    }
    console.log('PASS packaged basic gate');
  } finally {
    // A failed assertion may leave an unsaved test document; quit only this test process.
    if (app) await app.evaluate(({ app }) => app.exit(1)).catch(() => {});
  }
}
try {
  const sealed = (await readFuses(appPath)).enableNodeCliInspectArguments === false;
  if (sealed && full) throw new Error(`${appPath} has the inspect fuse off, so Playwright cannot attach to it. The full test runs during packaging.`);
  verifyModelAndInference();
  if (sealed) {
    console.log('The inspect fuse is off, so this runs the sealed-app checks. The full test ran during packaging, before the fuse was set.');
    await sealedChecks();
  } else await main();
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (process.exitCode || process.env.KEEP_PACKAGED_BASIC_ARTIFACTS === '1') console.log(`Artifacts: ${root}`); else rmSync(root, { recursive: true, force: true }); }
