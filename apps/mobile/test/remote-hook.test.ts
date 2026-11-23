import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { resolve } from "node:path";
import { formatInvite } from "@screenplay/relay/protocol";

// Drive useRemote's poll loop with stand-ins for React, the keychain, SQLite, the relay and the share sheet, so the
// status a writer sees can be checked against what the Mac answers.
const root = resolve(import.meta.dirname, "..");
const stubs: Record<string, string> = {
  react: `let slots = [], cursor = 0;
    export function begin() { cursor = 0; }
    export function unmount() { for (const s of slots) if (s && s.effect) s.cleanup?.(); slots = []; cursor = 0; }
    export function useState(value) { const i = cursor++;
      if (!(i in slots)) slots[i] = typeof value === "function" ? value() : value;
      return [slots[i], next => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; }
    export function useRef(value) { return useState(() => ({ current: value }))[0]; }
    export function useEffect(fn, deps) { const i = cursor++, old = slots[i];
      if (old && deps.every((d, k) => d === old.deps[k])) return;
      old?.cleanup?.(); slots[i] = { effect: true, deps }; slots[i].cleanup = fn(); }`,
  "react-native": `export const appState = [];
    export const AppState = { addEventListener(_, fn) { appState.push(fn); return { remove() { appState.splice(appState.indexOf(fn), 1); } }; } };`,
  "expo-secure-store": `export const keychain = { raw: null };
    export async function getItemAsync() { return keychain.raw; }
    export async function setItemAsync() {} export async function deleteItemAsync() {}
    export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 0;`,
  "expo-crypto": `import { randomUUID as uuid } from "node:crypto"; export const randomUUID = () => uuid();`,
  expo: `export const folder = { chosen: false, reads: 0, configured() { return this.chosen; }, deviceName: () => "iPhone", async read() { this.reads++; return null; }, async write() {} };
    export class NativeModule {} export const requireNativeModule = () => folder;`,
  "./crypto": `import { createHash } from "node:crypto";
    export const sha256 = async bytes => new Uint8Array(createHash("sha256").update(bytes).digest());`,
  "./link-crypto": `export { nodeLinkCrypto as linkCrypto } from "@screenplay/relay/sealed-node";`,
  "./live": `export const relay = {}; export const readScript = () => [];
    export function connect(pair, script, presence, status) { relay.status = status; return () => { relay.status = undefined; }; }`,
  "./production.ts": `export const folderProduction = () => ({});`,
  "./share.ts": `export const shared = []; export async function shareTakes(name, json) { shared.push(json); return true; }`,
  "./store": `export const takes = [], ended = new Map(); export const UNPAIRED = "";
    export const listTakes = () => [...takes].sort((a, b) => b.created - a.created).map(t => ({ ...t }));
    export function saveTake(t) { takes.push({ ...t }); } export const saveNote = saveTake;
    export function mark(id, outcome, error) { Object.assign(takes.find(t => t.id === id) ?? {}, { outcome, error }); }
    export const endedPairing = room => ended.get(room); export function rememberEnd(room, reason) { ended.set(room, reason); }
    export const claimUnpairedNotes = () => 0, cachedRows = () => [], cacheRows = () => {},
      cachedProduction = () => undefined, cacheProduction = () => {};`,
};
const result = await build({ stdin: { contents: `export { useRemote } from "./src/useRemote"; export { begin, unmount } from "react";
  export { appState } from "react-native"; export { keychain } from "expo-secure-store"; export { relay } from "./live";
  export { takes, ended } from "./store"; export { shared } from "./share.ts"; export { folder } from "expo";`, resolveDir: root },
  bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: "stubs" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "stubs" }, ({ path }) => ({ contents: stubs[path], resolveDir: root }));
  } }],
});
const hook = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0]!.text).toString("base64"));

const room = "r".repeat(22);
const remembered = JSON.stringify({ v: 1, url: `https://mac.tail123.ts.net:4456/#${"t".repeat(43)}`,
  invite: formatInvite({ relay: "wss://mac.tail123.ts.net:4456", key: "k".repeat(22), room, readOnly: true }),
  remembered: true, deviceId: "device-123456789", scriptId: "a".repeat(64), expiresAt: null });
const flush = () => new Promise(r => setImmediate(r));
const render = () => { hook.begin(); return hook.useRemote(); };
async function paired() {
  hook.unmount(); hook.takes.length = 0; hook.ended.clear(); hook.shared.length = 0;
  hook.keychain.raw = remembered;
  render(); await flush();
  render(); await flush();
  return render();
}
async function poll() {
  for (const fn of [...hook.appState]) fn("active");
  await flush();
  return render();
}
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test("a poll that succeeds after a failed one shows Live again while the relay is connected", async t => {
  let offline = true;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (offline) throw new TypeError("Network request failed");
    return answer(200, url.endsWith("/api/device") ? { open: true } : {});
  });
  hook.unmount(); hook.takes.length = 0; hook.ended.clear(); hook.keychain.raw = remembered;
  render(); await flush(); render();
  hook.relay.status("Live");
  await flush();
  assert.match(render().status, /^Can’t reach the Mac/, "one slow poll");
  offline = false;
  assert.equal((await poll()).status, "Live");
  hook.unmount();
});

test("only the Mac's revocation ends a remembered pairing; any other 403 is retried like an unreachable Mac", async t => {
  let reply = answer(403, { error: "Host refused." });
  t.mock.method(globalThis, "fetch", async () => reply.clone());
  assert.match((await paired()).status, /^Can’t reach the Mac/);
  assert.equal(hook.ended.size, 0);
  reply = answer(403, { error: "Origin refused." });
  assert.match((await poll()).status, /^Can’t reach the Mac/);
  assert.equal(hook.ended.size, 0, "the pairing still polls");
  reply = answer(403, { error: "This Mac revoked the pairing" });
  assert.equal((await poll()).status, "This Mac revoked the pairing");
  assert.equal(hook.ended.get(room), "This Mac revoked the pairing");
  hook.unmount();
});

test("takes sent by AirDrop with no decision from the Mac can be sent again", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Network request failed"); });
  await paired();
  hook.takes.push({ id: "receipt-123456789", room, kind: "note", text: "Lamp.", paragraphId: "p", sourceText: "",
    scene: "Scene 1", created: Date.now(), outcome: "pending" });
  assert.equal(await render().sendToMac(), 1);
  assert.equal(hook.takes[0].outcome, "airdropped");
  // The AirDrop was declined or failed: the share sheet cannot tell.
  assert.equal(await render().sendToMac(), 1);
  assert.equal(hook.shared.length, 2);
  assert.equal(JSON.parse(hook.shared[1]).takes[0].id, "receipt-123456789");
  hook.unmount();
});

test("a poll cut off by the relay ending the pairing leaves the ended status and skips the folder fallback", async t => {
  t.mock.method(globalThis, "fetch", (_url: string, options: RequestInit) =>
    new Promise((_, fail) => options.signal!.addEventListener("abort", () => fail(new Error("Aborted")))));
  hook.folder.chosen = true; hook.folder.reads = 0;
  await paired();
  hook.relay.status("Refused");
  await flush();
  assert.equal(render().status, "This Mac revoked the pairing");
  assert.equal(hook.folder.reads, 0);
  hook.folder.chosen = false;
  hook.unmount();
});

test("closing the share sheet does not overwrite a decision the Mac made while it was open", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Network request failed"); });
  await paired();
  hook.takes.push({ id: "receipt-123456789", room, kind: "note", text: "Lamp.", paragraphId: "p", sourceText: "",
    scene: "Scene 1", created: Date.now(), outcome: "airdropped" });
  hook.takes.push({ id: "receipt-987654321", room, kind: "note", text: "Rope.", paragraphId: "p", sourceText: "",
    scene: "Scene 1", created: Date.now(), outcome: "airdropped" });
  const sending = render().sendToMac();
  hook.takes[0].outcome = "accepted";
  assert.equal(await sending, 2);
  assert.deepEqual(hook.takes.map((t: { outcome: string }) => t.outcome), ["accepted", "airdropped"]);
  hook.unmount();
});
