import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { register } from "../src/main/services/phone.ts";
import type { Handler, ServiceContext } from "../src/main/context.ts";
import { PhoneDevices } from "../src/main/phone/devices.ts";
import { FolderGuard, PhoneFolder } from "../src/main/phone/folder.ts";
import { PhoneHost } from "../src/main/phone/host.ts";
import { lanAddresses, PhoneServer } from "../src/main/phone/server.ts";
import { phonePathKey } from "../src/main/phone/identity.ts";
import { Settings } from "../src/main/settings-store.ts";

const snapshot = (title: string) => ({ title, revision: title, cues: [] });
async function fixture(t: TestContext, paired = true) {
  const root = await mkdtemp(join(tmpdir(), "phone-publication-"));
  const paths = [join(root, "A.screenplay"), join(root, "B.screenplay")];
  const keys = paths.map(phonePathKey);
  const devices = new PhoneDevices(join(root, "phone-devices.json"));
  await devices.load();
  await devices.setFolder(new FolderGuard(root).grant());
  const entries = paired ? await Promise.all(keys.map(key => devices.create(key, "127.0.0.1", undefined, false))) : [];
  const hosts: PhoneHost[] = [];
  t.mock.method(PhoneHost.prototype, "start", async function(this: PhoneHost, _address: string, hostname: string, port: number) {
    this.origin = `http://${hostname}:${port}`;
    this.relay = { port, createRoom: () => ({ room: randomBytes(16).toString("base64url"), key: "k".repeat(22), readKey: "q".repeat(22) }),
      closeRoom() {}, async close() {} } as unknown as PhoneHost["relay"];
    hosts.push(this);
  });
  const handlers = new Map<string, Handler>(), quitting: (() => unknown)[] = [];
  const ctx = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    paths: { userData: root }, settings: new Settings(join(root, "settings.json")),
    broadcast() {}, send() {}, isAllowedPath: (path: string) => paths.includes(path),
    onQuit: (callback: () => unknown) => quitting.push(callback), windowOf: () => ({}),
  } as unknown as ServiceContext;
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender } as never, ...args);
  register(ctx, { clipboard: {}, dialog: { showMessageBox: async () => ({ response: 1 }) } } as never, async () => null);
  const quit = () => Promise.all(quitting.map(fn => fn()));
  t.after(async () => { await quit(); await rm(root, { recursive: true, force: true }); });
  for (const path of paths) await call("phone:path-key", path);
  const read = async (entry: typeof entries[number]) => {
    let status = 0, result = "";
    await hosts[0]!.routes.get(entry.device.tokenHash)!({ method: "GET", url: "/api/snapshot", socket: { remoteAddress: "127.0.0.1" },
      headers: { authorization: "Bearer " + entry.token, host: new URL(hosts[0]!.origin).host } } as never,
    { writeHead(code: number) { status = code; }, end(body: string) { result = body; } } as never);
    assert.equal(status, 200);
    return JSON.parse(result);
  };
  const readFolder = (deviceId: string) => readFile(join(root, "Inklot Phone Inbox", deviceId, "production.json"), "utf8").then(JSON.parse);
  return { root, call, keys, entries, read, readFolder, quit };
}

for (const replacement of ["resume", "pairing"] as const) test(`a same-script ${replacement} during folder I/O retains every publisher`, async t => {
  const address = lanAddresses()[0]?.address;
  if (replacement === "pairing" && !address) { t.skip("Requires a private LAN interface"); return; }
  const f = await fixture(t);
  const attach = PhoneServer.prototype.attach, invites: ReturnType<PhoneServer["attach"]>["publisher"][] = [];
  let attached!: () => void;
  const replacementAttached = new Promise<void>(resolve => { attached = resolve; });
  t.mock.method(PhoneServer.prototype, "attach", function(this: PhoneServer, ...args: Parameters<PhoneServer["attach"]>) {
    const info = attach.apply(this, args);
    invites.push(info.publisher);
    if (invites.length === 2) attached();
    return info;
  });
  const publish = PhoneFolder.prototype.publish;
  let release!: () => void, started!: () => void;
  const stalled = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(PhoneFolder.prototype, "publish", async function(this: PhoneFolder, key: string, value: Parameters<PhoneFolder["publish"]>[1]) {
    if (value.revision === "A-initial") { started(); await new Promise<void>(resolve => { release = resolve; }); }
    return publish.call(this, key, value);
  });
  const initial = f.call("phone:resume", f.keys[0], snapshot("A-initial"));
  await stalled;
  let next: Promise<unknown>;
  try {
    next = replacement === "pairing"
      ? f.call("phone:start", address, snapshot("A-new"), f.keys[0], "http", true)
      : f.call("phone:resume", f.keys[0], snapshot("A-new"));
    if (replacement === "pairing") await replacementAttached;
    else await next;
  } finally { release(); }
  const result = await initial as { publishers: typeof invites };
  await next!;
  assert.deepEqual(result.publishers, invites);
  const resumed = await f.call("phone:resume", f.keys[0], snapshot("A-final")) as { publishers: typeof invites };
  assert.deepEqual(resumed.publishers, invites);
});

for (const state of ["delayed", "failed", "stopping"] as const) test(`folder publication coalesces edits with a ${state} initial write`, async t => {
  const f = await fixture(t);
  const probe = await open(join(f.root, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const writeFile = prototype.writeFile;
  await probe.close();
  let release!: () => void, started!: () => void;
  const stalled = new Promise<void>(resolve => { started = resolve; });
  const writes: string[] = [];
  t.mock.method(prototype, "writeFile", async function(this: FileHandle, ...args: Parameters<FileHandle["writeFile"]>) {
    await writeFile.apply(this, args);
    const text = args[0];
    if (typeof text !== "string" || !text.includes('"v":2,"scriptId":')) return;
    const value = JSON.parse(text);
    writes.push(value.revision);
    if (value.revision === "A-initial") {
      started(); await new Promise<void>(resolve => { release = resolve; });
      if (state === "failed") throw new Error("Simulated write failure");
    }
  });
  const initial = f.call("phone:resume", f.keys[0], snapshot("A-initial"));
  await stalled;
  const intermediate = f.call("phone:publish", snapshot("A-intermediate"));
  const latest = f.call("phone:publish", snapshot("A-latest"));
  const stopping = state === "stopping" ? f.quit() : undefined;
  try {
    assert.equal((await f.read(f.entries[0]!)).title, "A-latest");
  } finally { release(); await Promise.all([initial, intermediate, latest, stopping]); }
  assert.equal((await f.readFolder(f.entries[0]!.device.id)).title, "A-latest");
  assert.deepEqual(writes, ["A-initial", "A-latest"]);
});

test("a stalled folder publication cannot publish the old script into a newly resumed phone", async t => {
  const f = await fixture(t);
  await f.call("phone:resume", f.keys[0], snapshot("A"));
  const publish = PhoneFolder.prototype.publish;
  let release!: () => void, started!: () => void;
  const stalled = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(PhoneFolder.prototype, "publish", async function(this: PhoneFolder, key: string, value: Parameters<PhoneFolder["publish"]>[1]) {
    if (value.revision === "A-stalled") { started(); await new Promise<void>(resolve => { release = resolve; }); }
    return publish.call(this, key, value);
  });
  const pending = f.call("phone:publish", snapshot("A-stalled"));
  await stalled;
  try {
    await f.call("phone:resume", f.keys[1], snapshot("B"));
  } finally { release(); await pending; }
  assert.equal((await f.read(f.entries[1]!)).title, "B");
  assert.equal((await f.readFolder(f.entries[0]!.device.id)).scriptId, f.keys[0]);
});

test("resume initializes and refreshes the remembered phone's folder without another edit", async t => {
  const f = await fixture(t);
  await f.call("phone:resume", f.keys[0], snapshot("A"));
  assert.equal((await f.readFolder(f.entries[0]!.device.id)).title, "A");
  await f.call("phone:resume", f.keys[0], snapshot("A-new"));
  assert.equal((await f.readFolder(f.entries[0]!.device.id)).title, "A-new");
  assert.equal((await f.read(f.entries[0]!)).title, "A-new");
});

test("a new remembered pairing initializes its folder from the current snapshot", async t => {
  const address = lanAddresses()[0]?.address;
  if (!address) { t.skip("Requires a private LAN interface"); return; }
  const f = await fixture(t, false);
  await f.call("phone:resume", f.keys[0], snapshot("A"));
  const info = await f.call("phone:start", address, snapshot("A"), f.keys[0], "http", true) as { pairing: string };
  assert.equal((await f.readFolder(JSON.parse(info.pairing).deviceId)).title, "A");
});
