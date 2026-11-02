// Real phone HTTP service and durable inbox, exercised by a mobile-sized browser.
// Loopback HTTP is deliberate in this isolated test; HTTPS/key validation has separate unit coverage.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { PhoneServer } from '../src/main/phone/server.ts';
import { PhoneInboxStore } from '../src/main/phone/inbox.ts';

const root = await mkdtemp(join(tmpdir(), 'coldopen-phone-browser-'));
const output = resolve(process.env.SCREENPLAY_ACCEPTANCE_OUTPUT ?? 'apps/desktop/test-results/phone-browser');
await mkdir(output, { recursive: true });
const key = 'browser-acceptance-project';
const store = new PhoneInboxStore(join(root, 'inbox'));
const snapshot = { title: 'Phone acceptance fixture', revision: 'fixture:1', cues: [
  { id: 'cue-1', paragraphId: 'p1', speaker: 'MARA', heading: 'INT. KITCHEN - NIGHT', text: 'You said the door was locked.' },
  { id: 'cue-2', paragraphId: 'p2', speaker: 'ELI', heading: 'INT. KITCHEN - NIGHT', text: 'I said I locked it.' },
] };
let failNext = true;
const writes = [], commands = [];
const server = new PhoneServer(snapshot, command => commands.push(command), async item => {
  writes.push(item.id);
  if (failNext) { failNext = false; throw new Error('Simulated full disk'); }
  await store.append(key, item);
});
const link = await server.start('127.0.0.1');
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  args: ['--no-sandbox'] });
const bridged = process.argv.includes('--transport-bridge');
const savedStorage = {};
const checks = [], errors = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
let success = false;
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on('pageerror', error => errors.push(error.message));
  if (bridged) {
    // Restricted validation browsers may refuse local-network navigations. This optional fixture
    // preserves the shipped client logic but replaces browser transport/storage/location with explicit
    // test adapters. It is NOT browser TLS, native link handling, or persistent-storage acceptance.
    await page.exposeFunction('__phoneHttp', async (path, options = {}) => {
      if (!['/api/snapshot', '/api/inbox', '/api/command'].includes(path)) throw new Error('Test transport refused');
      const response = await fetch(new URL(path, link.url), options);
      return { status: response.status, body: await response.text() };
    });
    await page.exposeFunction('__phoneRemember', (name, value) => { if (value === null) delete savedStorage[name]; else savedStorage[name] = value; });
  }
  const loadPage = async () => {
    if (!bridged) return page.goto(link.url);
    const html = await (await fetch(new URL('/', link.url))).text();
    const code = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert(code, 'Phone page needs its shipped client script');
    await page.goto('about:blank');
    await page.setContent(html.replace(/<script nonce="[^"]+">[\s\S]*?<\/script>/, ''));
    await page.evaluate(({ code, token, storage }) => {
      const data = { ...storage };
      const store = { getItem: key => data[key] ?? null,
        setItem: (key, value) => { data[key] = value; void window.__phoneRemember(key, value); },
        removeItem: key => { delete data[key]; void window.__phoneRemember(key, null); } };
      const transport = async (path, options) => { const reply = await window.__phoneHttp(path, options); return new Response(reply.body, { status: reply.status }); };
      window.__testPhoneStorage = data; window.__testPhoneFetch = transport;
      new Function('fetch', 'location', 'history', 'localStorage', code)(transport, { hash: '#' + token, pathname: '/' },
        { replaceState: (_state, _title, path) => { window.__testPhonePath = path; } }, store);
    }, { code, token: new URL(link.url).hash.slice(1), storage: savedStorage });
  };
  await loadPage();
  await expect(page.getByRole('heading', { name: snapshot.title, exact: true })).toBeVisible();
  if (bridged) assert.equal(await page.evaluate(() => window.__testPhonePath), '/');
  else assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.evaluate(() => JSON.stringify(window.__testPhoneStorage ?? { ...localStorage }).includes('Bearer')), false);
  assert.equal(await page.evaluate(async () => (await (window.__testPhoneFetch ?? fetch)('/api/snapshot')).status), 401);
  check('pairing secret leaves the URL and is not persisted; unauthenticated reading is refused');
  const text = page.getByRole('textbox', { name: 'Note or dictated text' });
  const note = 'Preserve <script>literal text</script> and café. No automatic screenplay edits.';
  await text.fill(note);
  await page.getByRole('button', { name: 'Send to desktop inbox', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be saved');
  await expect(text).toHaveValue(note);
  assert.equal((await store.list(key)).length, 0);
  await page.screenshot({ path: join(output, 'phone-unsent-retry.png'), fullPage: true });
  await page.getByRole('button', { name: 'Send to desktop inbox', exact: true }).click();
  await expect(text).toHaveValue('');
  await expect(page.getByRole('alert')).toBeEmpty();
  await expect(page.locator('#connection')).toContainText('Saved in the desktop review inbox');
  const rows = await store.list(key);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, note);
  assert.equal(writes[0], writes[1]);
  check('disk failures retain unsent text; a retry persists exactly once under the original receipt');

  await text.fill('Keep this pending note through a reading update.');
  server.publish({ ...snapshot, revision: 'fixture:2' });
  await page.getByRole('button', { name: 'Send to desktop inbox', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('shared reading changed');
  await expect(text).not.toHaveValue('');
  await page.getByRole('button', { name: 'Reload shared reading', exact: true }).click();
  await expect(page.locator('#connection')).toContainText('fixture:2');
  await page.getByRole('button', { name: 'Send to desktop inbox', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('attach it to a current passage');
  await page.getByRole('combobox', { name: 'Reading passage' }).selectOption('1');
  await page.getByRole('button', { name: 'Attach unsent text to current passage', exact: true }).click();
  await page.getByRole('button', { name: 'Send to desktop inbox', exact: true }).click();
  await expect(text).toHaveValue('');
  const updated = await store.list(key);
  assert.equal(updated.length, 2); assert.equal(updated[1].paragraphId, 'p2'); assert.equal(updated[1].revision, 'fixture:2');
  check('stale reading notes require explicit retargeting; durable source references match the selected passage');

  await page.getByText('Control the Mac’s active table read', { exact: true }).click();
  await page.locator('[data-command="pause"]').click();
  await expect.poll(() => commands).toEqual(['pause']);
  check('remote transport emits the bounded command without changing script text');
  await text.fill('An unsent draft survives reopening its pairing link.');
  if (bridged) await expect.poll(() => Object.values(savedStorage).some(v => v.includes('An unsent draft'))).toBe(true);
  await loadPage();
  await expect(text).toHaveValue('An unsent draft survives reopening its pairing link.');
  const local = await page.evaluate(() => JSON.stringify(window.__testPhoneStorage ?? { ...localStorage }));
  assert(!local.includes(new URL(link.url).hash.slice(1)));
  check('browser reload retains unsent words but not the pairing secret');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Phone page must not scroll horizontally');
  await page.screenshot({ path: join(output, 'phone-mobile-reading.png'), fullPage: true });
  const ax = await (await page.context().newCDPSession(page)).send('Accessibility.getFullAXTree');
  const named = ax.nodes.filter(node => !node.ignored && ['button', 'combobox', 'textbox'].includes(node.role?.value));
  assert(named.length >= 12);
  assert(named.every(node => String(node.name?.value ?? '').trim()), 'Phone controls need accessible names');
  check('mobile layout fits 390px and exposed actionable controls have accessible names');
  await server.stop();
  await page.getByRole('button', { name: 'Send to desktop inbox', exact: true }).click();
  await expect(page.getByRole('alert')).not.toBeEmpty();
  await expect(text).toHaveValue('An unsent draft survives reopening its pairing link.');
  assert.deepEqual(errors, []);
  check('revoked session cannot clear unsent text or silently send it elsewhere');
  success = true;
} finally {
  await browser.close(); await server.stop(); await store.flush();
  await writeFile(join(output, 'result.json'), JSON.stringify({ success, checks, pageErrors: errors,
    scope: bridged ? 'Shipped client in mobile-sized Chromium with explicit HTTP/storage/location test adapters to the real Node server and durable inbox. Not browser network/TLS, native link handling, iPhone/Safari, or VoiceOver acceptance.' : 'Real loopback HTTP server and durable inbox in mobile-sized Chromium; not an iPhone/Safari or VoiceOver test.' }, null, 2));
  await rm(root, { recursive: true, force: true });
}
