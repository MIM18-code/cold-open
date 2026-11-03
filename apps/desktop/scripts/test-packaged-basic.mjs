// Exercises the packaged app with fictional scripts and an attributed speech test fixture.
// Native file pickers and the exact CJK system-font confirmation receive test responses;
// no PDF rendering or other app functionality is mocked.
// Run after packaging: node apps/desktop/scripts/test-packaged-basic.mjs [path/to/Cold Open.app]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { PDFDocument } from 'pdf-lib';

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(process.argv[2] ?? join(here, '../release/mac-arm64/Cold Open.app'));
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

async function main() {
  verifyModelAndInference();
  const launch = (profile, path) => electron.launch({ executablePath: binary, args: [`--user-data-dir=${output(profile)}`, ...(path ? [path] : [])], env });
  let app;
  const open = async (profile, path) => { app = await launch(profile, path); assert.equal(await app.evaluate(({ app }) => app.getVersion()), expectedVersion, 'Packaged app version differs from package.json'); const p = await app.firstWindow(); await p.locator('.editor-pm').waitFor(); return p; };
  const close = async () => { if (app) { await app.close(); app = undefined; } };
  const command = async (p, name) => { await p.getByText('Commands', { exact: true }).click(); await p.getByText(name, { exact: false }).first().click(); };
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
    console.log('PASS packaged basic gate');
  } finally {
    // A failed assertion may leave an unsaved test document; quit only this test process.
    if (app) await app.evaluate(({ app }) => app.exit(1)).catch(() => {});
  }
}
try { await main(); } catch (error) { console.error(error); process.exitCode = 1; }
finally { if (process.exitCode || process.env.KEEP_PACKAGED_BASIC_ARTIFACTS === '1') console.log(`Artifacts: ${root}`); else rmSync(root, { recursive: true, force: true }); }
