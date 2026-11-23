// The Phone service on home Wi-Fi: pairing codes, the opt-in Safari link, iPhones paired before links were sealed,
// and revocation.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fromBase64url, linkKeys, linkRoot } from "@screenplay/relay/sealed";
import { register } from "../src/main/services/phone.ts";
import type { Handler, ServiceContext } from "../src/main/context.ts";
import { PhoneDevices } from "../src/main/phone/devices.ts";
import { PhoneHost } from "../src/main/phone/host.ts";
import { lanAddresses } from "../src/main/phone/server.ts";
import { phonePathKey } from "../src/main/phone/identity.ts";
import { Settings } from "../src/main/settings-store.ts";
import { decodePairing } from "../../mobile/src/pairing.ts";
import { nodeLinkCrypto } from "@screenplay/relay/sealed-node";

const snapshot = { title: "Ferry", revision: "v1", cues: [] };
interface Status {
  url: string; urlEncrypted: boolean; pairing?: string; active: boolean; liveRemembered: boolean;
  remembered: { id: string; pairAgain?: boolean; tailscale?: boolean }[];
}

async function fixture(t: TestContext, prepare?: (devices: PhoneDevices, key: string) => Promise<void>,
  options: { detect?: () => Promise<unknown>; timers?: boolean; blocker?: { start(): number; stop(): void }; keepAwake?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "phone-sealed-service-"));
  const path = join(root, "Ferry.screenplay"), key = phonePathKey(path), paths = [path];
  const devices = new PhoneDevices(join(root, "phone-devices.json"));
  await prepare?.(devices, key);
  const hosts: PhoneHost[] = [];
  t.mock.method(PhoneHost.prototype, "start", async function(this: PhoneHost, address: string, hostname: string, port: number, tls?: unknown) {
    this.origin = `${tls ? "https" : "http"}://${hostname}:${port}`;
    this.address = address;
    this.sealed = !tls;
    this.relay = { port, createRoom: () => ({ room: randomBytes(16).toString("base64url"), key: "k".repeat(22), readKey: "q".repeat(22) }),
      closeRoom() {}, async close() {} } as unknown as PhoneHost["relay"];
    hosts.push(this);
  });
  const handlers = new Map<string, Handler>(), quitting: (() => unknown)[] = [];
  const dialogs: string[] = [], broadcasts: string[] = [];
  const settings = new Settings(join(root, "settings.json"));
  if (options.keepAwake) settings.set("phone.keepAwake", true);
  const ctx = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    paths: { userData: root }, settings,
    broadcast(channel: string) { broadcasts.push(channel); }, send() {}, isAllowedPath: (candidate: string) => paths.includes(candidate),
    onQuit: (callback: () => unknown) => quitting.push(callback), windowOf: () => ({}),
  } as unknown as ServiceContext;
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender } as never, ...args);
  if (options.timers) t.mock.timers.enable({ apis: ["setInterval"] });
  register(ctx, { clipboard: { writeText() {} }, powerSaveBlocker: options.blocker,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [join(root, "cloud")] }), showMessageBox: async (_window: unknown, box: { detail: string }) => {
      dialogs.push(box.detail); return { response: 1 };
    } } } as never, (options.detect ?? (async () => null)) as never);
  t.after(async () => { await Promise.all(quitting.map(fn => fn())); await rm(root, { recursive: true, force: true }); });
  await call("phone:path-key", path);
  return { root, call, key, paths, hosts, handlers, dialogs, broadcasts, status: () => call("phone:status", key) as Promise<Status> };
}

test("remembering an iPhone on home Wi-Fi makes a sealed pairing with no Safari link and nothing to choose", async t => {
  const address = lanAddresses()[0]?.address;
  if (!address) { t.skip("Requires a private LAN interface"); return; }
  const f = await fixture(t);
  assert.equal(f.handlers.has("phone:choose-tls"), false, "the certificate chooser is gone");
  await assert.rejects(f.call("phone:start", address, snapshot, f.key, true, true), /Safari link/);
  await assert.rejects(f.call("phone:start", address, snapshot, f.key, "http", true), /remember/);
  const info = await f.call("phone:start", address, snapshot, f.key, true) as { pairing: string; url: string };
  assert.match(f.dialogs.at(-1)!, /The link is encrypted\./);
  const code = JSON.parse(info.pairing);
  assert.equal(code.v, 3);
  assert.equal(code.url, undefined);
  assert.equal(info.url, "");
  const pair = decodePairing(info.pairing, nodeLinkCrypto);
  assert.equal(pair.origin, `http://${address}:4456`);
  assert.ok(pair.link && pair.remembered);
  const status = await f.status();
  assert.equal(status.url, "");
  assert.equal(status.remembered[0]?.pairAgain, undefined);
  assert.equal(status.remembered[0]?.tailscale, undefined, "a home Wi-Fi pairing does not count as usable away from home");
  await assert.rejects(f.call("phone:copy-link", "browser"), /no Safari link/);
  await f.call("phone:copy-link", "remote");

  // The Mac keeps a key derived from the secret, in its private state, and can serve the iPhone with it.
  const stored = await readFile(join(f.root, "phone-devices.json"), "utf8");
  assert.ok(!stored.includes(code.secret));
  assert.equal(JSON.parse(stored).devices[0].root, Buffer.from(linkRoot(nodeLinkCrypto, code.secret)).toString("base64url"));
  assert.equal(JSON.parse(stored).devices[0].link, undefined);
  const link = f.hosts[0]!.links.get(pair.link!.id)!;
  assert.equal((await link.handle({ t: Date.now(), m: "GET", p: "/api/device" }, "127.0.0.1")).status, 200);

  // Revoked: the iPhone still gets an answer it can verify, and the answer is no.
  await f.call("phone:revoke", status.remembered[0]!.id);
  const parked = f.hosts[0]!.links.get(pair.link!.id)!;
  assert.notEqual(parked, link);
  assert.deepEqual(await parked.handle({ t: Date.now(), m: "GET", p: "/api/device" }, "127.0.0.1"),
    { status: 403, body: { error: "This Mac revoked the pairing" } });
  assert.deepEqual((await f.status()).remembered, []);
});

test("an iPhone paired by an earlier version gets no listener and is marked for pairing again", async t => {
  const earlier: string[] = [];
  let current = "";
  const f = await fixture(t, async (devices, key) => {
    const unsealed = await devices.create(key, "192.168.1.20"), beta13 = await devices.create(key, "192.168.1.20");
    const sealed = await devices.create(key, "192.168.1.20");
    earlier.push(unsealed.device.id, beta13.device.id); current = sealed.device.root!;
    const state = JSON.parse(await readFile(devices.path, "utf8"));
    // Before links were sealed: no link key, and a flag for the HTTP or custom-certificate listener.
    delete state.devices[0].root; state.devices[0].encrypted = false;
    // Mac beta 13: a version 2 root under `link`, which no version 3 key can be made from.
    delete state.devices[1].root; state.devices[1].link = randomBytes(32).toString("base64url");
    await writeFile(devices.path, JSON.stringify(state));
  });
  const resumed = await f.call("phone:resume", f.key, snapshot) as { publishers: unknown[] };
  assert.equal(resumed.publishers.length, 1, "only the version 3 iPhone is served");
  assert.equal(f.hosts.length, 1);
  assert.equal(f.hosts[0]!.sealed, true);
  assert.equal(f.hosts[0]!.routes.size, 0, "no bearer is accepted on home Wi-Fi");
  assert.deepEqual([...f.hosts[0]!.links.keys()], [linkKeys(nodeLinkCrypto, fromBase64url(current)).id]);
  const status = await f.status();
  assert.deepEqual(status.remembered.map(d => [earlier.includes(d.id), d.pairAgain ?? false]).sort(),
    [[false, false], [true, true], [true, true]]);
});

test("a one-off home pairing offers the Safari link only when asked, and says it is not encrypted", async t => {
  const address = lanAddresses()[0]?.address;
  if (!address) { t.skip("Requires a private LAN interface"); return; }
  const f = await fixture(t);
  const plain = await f.call("phone:start", address, snapshot, f.key) as { pairing: string; url: string };
  assert.equal(plain.url, "");
  assert.equal(JSON.parse(plain.pairing).v, 3);
  assert.match(f.dialogs.at(-1)!, /The link is encrypted\./);
  assert.doesNotMatch(f.dialogs.at(-1)!, /Safari/);
  await f.call("phone:stop");
  const both = await f.call("phone:start", address, snapshot, f.key, false, true) as { pairing: string; url: string };
  assert.match(both.url, /^http:\/\/[\d.]+:\d+\/#[\w-]{43}$/);
  assert.notEqual(new URL(both.url).hash.slice(1), JSON.parse(both.pairing).secret);
  assert.match(f.dialogs.at(-1)!, /The Safari link is not/);
  const status = await f.status();
  assert.equal(status.url, both.url);
  assert.equal(status.urlEncrypted, false);
  await f.call("phone:stop");
});

// Item numbers below refer to the phone audit of November 2026.
test("saving an untitled script keeps its one-off link; Save As on a saved script still ends it", async t => {
  const address = lanAddresses()[0]?.address;
  if (!address) { t.skip("Requires a private LAN interface"); return; }
  const f = await fixture(t);
  const untitled = "11111111-2222-3333-4444-555555555555";
  await f.call("phone:claim-key", untitled);
  await f.call("phone:resume", untitled, snapshot);
  await f.call("phone:start", address, snapshot, untitled);
  // The first save can assign a history ID before the path exists, so the renderer moves the inbox twice:
  // untitled key, then history-ID key, then path key, resuming after each.
  const history = "66666666-7777-4888-9999-aaaaaaaaaaaa";
  await f.call("phone:claim-key", history);
  await f.call("phone:move-inbox", untitled, history);
  await f.call("phone:resume", history, snapshot);
  assert.equal((await f.call("phone:status", history) as Status).active, true, "the link survives the history ID");
  await f.call("phone:move-inbox", history, f.key);
  const saved = await f.call("phone:resume", f.key, snapshot) as { shared: boolean; oneOff: boolean };
  assert.equal((await f.status()).active, true, "the link the writer just made survives the first save");
  assert.deepEqual([saved.shared, saved.oneOff], [true, true]);
  // Save As makes a different document, so the one-off link ends.
  const copy = join(f.root, "Ferry copy.screenplay");
  f.paths.push(copy);
  const copyKey = await f.call("phone:path-key", copy) as string;
  await f.call("phone:move-inbox", f.key, copyKey);
  const moved = await f.call("phone:resume", copyKey, snapshot) as { shared: boolean; oneOff: boolean };
  assert.equal((await f.call("phone:status", copyKey) as Status).active, false);
  assert.deepEqual([moved.shared, moved.oneOff], [false, false], "nothing is shared, so the renderer can skip publishing");
});

test("Stop sharing ends only the one-off link and leaves remembered iPhones paired and connected", async t => {
  const address = lanAddresses()[0]?.address;
  if (!address) { t.skip("Requires a private LAN interface"); return; }
  const f = await fixture(t, async (devices, key) => { await devices.create(key, "192.168.1.20"); await devices.flush(); });
  const resumed = await f.call("phone:resume", f.key, snapshot) as { publishers: unknown[]; shared: boolean; oneOff: boolean };
  assert.equal(resumed.publishers.length, 1);
  assert.deepEqual([resumed.shared, resumed.oneOff], [true, false]);
  // Tools > Stop One-Off Phone Link with no one-off link does nothing to the remembered iPhone.
  await f.call("phone:stop");
  let status = await f.status();
  assert.equal(status.remembered.length, 1);
  assert.equal(status.liveRemembered, true);
  await f.call("phone:start", address, snapshot, f.key);
  assert.equal((await f.status()).active, true);
  await f.call("phone:stop");
  status = await f.status();
  assert.equal(status.active, false, "the one-off link stopped");
  assert.equal(status.remembered.length, 1, "the remembered iPhone is still paired");
  assert.equal(status.liveRemembered, true, "and still connected");
  const again = await f.call("phone:resume", f.key, snapshot) as { publishers: unknown[] };
  assert.equal(again.publishers.length, 1);
});

test("the 30 second listener retry announces sharing changes only when something changed", async t => {
  const f = await fixture(t, async (devices, key) => { await devices.create(key, "192.168.1.20"); await devices.flush(); },
    { timers: true });
  await f.call("phone:resume", f.key, snapshot);
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  const before = f.broadcasts.filter(c => c === "phone:sharing-changed").length;
  assert.ok(before >= 1, "the first restore announces itself");
  t.mock.timers.tick(30000); await settle();
  t.mock.timers.tick(30000); await settle();
  assert.equal(f.broadcasts.filter(c => c === "phone:sharing-changed").length, before);
});

test("overlapping starts are refused before the Tailscale certificate, and a failed start leaves no dead link", async t => {
  const tail = { address: "100.114.165.59", hostname: "mac.tail123.ts.net", cli: "/not/a/tailscale", tailscale: true, name: "Tailscale" };
  const f = await fixture(t, undefined, { detect: async () => tail });
  const results = await Promise.allSettled([
    f.call("phone:start", tail.address, snapshot, f.key), f.call("phone:start", tail.address, snapshot, f.key)]);
  const reasons = results.map(r => r.status === "rejected" ? String(r.reason) : "fulfilled").sort();
  assert.match(reasons[0]!, /Tailscale CLI/);
  assert.match(reasons[1]!, /Stop this window/);
  await assert.rejects(f.call("phone:start", tail.address, snapshot, f.key), /Tailscale CLI/, "a failed start releases the window");
});

test("an error after a remembered pairing is registered removes it", async t => {
  const address = lanAddresses()[0]?.address;
  if (!address) { t.skip("Requires a private LAN interface"); return; }
  let fail = true, held = 0;
  const f = await fixture(t, undefined, { keepAwake: true, blocker: {
    start() { if (fail) { fail = false; throw new Error("No power assertion"); } return ++held; }, stop() {},
  } });
  await assert.rejects(f.call("phone:start", address, snapshot, f.key, true), /No power assertion/);
  assert.equal((await f.status()).active, false);
  await f.call("phone:start", address, snapshot, f.key, true);
  assert.equal((await f.status()).active, true);
});

test("the iCloud folder counts as shared only for a script with a paired iPhone", async t => {
  const resumeShared = async (f: Awaited<ReturnType<typeof fixture>>) => {
    await mkdir(join(f.root, "cloud"), { recursive: true });
    await f.call("phone:choose-folder");
    return (await f.call("phone:resume", f.key, snapshot) as { publishers: unknown[]; shared: boolean });
  };
  const alone = await resumeShared(await fixture(t));
  assert.equal(alone.shared, false, "the folder writer writes nothing for this script");
  // An iPhone that needs pairing again gets no live link, but the folder still writes for it.
  const paired = await resumeShared(await fixture(t, async (devices, key) => {
    await devices.create(key, "192.168.1.20");
    const state = JSON.parse(await readFile(devices.path, "utf8"));
    delete state.devices[0].root; state.devices[0].encrypted = false;
    await writeFile(devices.path, JSON.stringify(state));
  }));
  assert.equal(paired.publishers.length, 0);
  assert.equal(paired.shared, true);
});
