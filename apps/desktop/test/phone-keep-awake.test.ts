// Keep this Mac awake: the Phone service holds one power save blocker only while the setting is on, the app is not
// quitting, and an iPhone pairing is live.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { register } from "../src/main/services/phone.ts";
import type { Handler, ServiceContext } from "../src/main/context.ts";
import { PhoneDevices } from "../src/main/phone/devices.ts";
import { PhoneHost } from "../src/main/phone/host.ts";
import { lanAddresses } from "../src/main/phone/server.ts";
import { phonePathKey } from "../src/main/phone/identity.ts";
import { Settings } from "../src/main/settings-store.ts";

const snapshot = { title: "Ferry", revision: "v1", cues: [] };

/** A fake powerSaveBlocker that records every call and fails on a second start or a stray stop. */
function fakeBlocker() {
  const calls: string[] = [];
  let next = 1, held: number | undefined;
  return {
    calls,
    starts: () => calls.filter(c => c.startsWith("start")).length,
    stops: () => calls.filter(c => c.startsWith("stop")).length,
    powerSaveBlocker: {
      start(type: string) {
        assert.equal(type, "prevent-app-suspension");
        assert.equal(held, undefined, "a second blocker started without stopping the first");
        held = next++;
        calls.push(`start:${held}`);
        return held;
      },
      stop(id: number) {
        assert.equal(id, held, "stopped a blocker that is not held");
        held = undefined;
        calls.push(`stop:${id}`);
      },
    },
  };
}

/** The service with one remembered home iPhone for the script, so phone:resume makes sharing live without a LAN. */
async function fixture(t: TestContext, options: { remembered?: boolean; keepAwake?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "phone-keep-awake-"));
  const path = join(root, "Ferry.screenplay"), key = phonePathKey(path);
  if (options.remembered) {
    const devices = new PhoneDevices(join(root, "phone-devices.json"));
    await devices.load();
    await devices.create(key, "192.168.1.20");
    await devices.flush();
  }
  t.mock.method(PhoneHost.prototype, "start", async function(this: PhoneHost, address: string, hostname: string, port: number, tls?: unknown) {
    this.origin = `${tls ? "https" : "http"}://${hostname}:${port}`;
    this.address = address;
    this.sealed = !tls;
    this.relay = { port, createRoom: () => ({ room: randomBytes(16).toString("base64url"), key: "k".repeat(22), readKey: "q".repeat(22) }),
      closeRoom() {}, async close() {} } as unknown as PhoneHost["relay"];
  });
  const settings = new Settings(join(root, "settings.json"));
  if (options.keepAwake) settings.set("phone.keepAwake", true);
  const handlers = new Map<string, Handler>(), quitting: (() => unknown)[] = [], broadcasts: string[] = [];
  const ctx = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    paths: { userData: root }, settings,
    broadcast(channel: string) { broadcasts.push(channel); }, send() {}, isAllowedPath: (candidate: string) => candidate === path,
    onQuit: (callback: () => unknown) => quitting.push(callback), windowOf: () => ({}),
  } as unknown as ServiceContext;
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender } as never, ...args);
  const blocker = fakeBlocker();
  register(ctx, { clipboard: { writeText() {} }, dialog: { showMessageBox: async () => ({ response: 1 }) },
    powerSaveBlocker: blocker.powerSaveBlocker } as never, async () => null);
  let quit: Promise<unknown> | undefined;
  /** Starts quitting and returns at once, so a test can look at the state before the cleanup has finished. */
  const beginQuit = () => quit ??= Promise.all(quitting.map(fn => fn()));
  const quitNow = async () => { await beginQuit(); };
  t.after(async () => { await quitNow(); await rm(root, { recursive: true, force: true }); });
  await call("phone:path-key", path);
  const status = async () => {
    const { keepAwake, awake } = await call("phone:status", key) as { keepAwake: boolean; awake: boolean };
    return { keepAwake, awake };
  };
  const share = async () => {
    const resumed = await call("phone:resume", key, snapshot) as { publishers: unknown[] };
    assert.equal(resumed.publishers.length, 1, "the remembered iPhone is live");
  };
  return { call, key, blocker, broadcasts, status, share, quit: quitNow, beginQuit, sender, settings };
}

test("with the setting off, sharing never touches powerSaveBlocker", async t => {
  const f = await fixture(t, { remembered: true });
  assert.deepEqual(await f.status(), { keepAwake: false, awake: false });
  await f.share();
  assert.deepEqual(f.blocker.calls, []);
  assert.deepEqual(await f.status(), { keepAwake: false, awake: false });
  await f.call("phone:detach");
  assert.deepEqual(f.blocker.calls, []);
});

test("the setting alone holds nothing until sharing starts, and sharing stopping releases it", async t => {
  const f = await fixture(t, { remembered: true });
  await f.call("phone:set-keep-awake", true);
  assert.deepEqual(f.blocker.calls, [], "no blocker without a live pairing");
  assert.deepEqual(await f.status(), { keepAwake: true, awake: false });
  await f.share();
  assert.deepEqual(f.blocker.calls, ["start:1"]);
  assert.deepEqual(await f.status(), { keepAwake: true, awake: true });
  await f.share();
  assert.equal(f.blocker.starts(), 1, "resuming again does not start a second blocker");
  await f.call("phone:detach");
  assert.deepEqual(f.blocker.calls, ["start:1", "stop:1"]);
  assert.deepEqual(await f.status(), { keepAwake: true, awake: false });
});

test("turning the setting off while sharing releases it, and on again holds it", async t => {
  const f = await fixture(t, { remembered: true });
  await f.share();
  assert.deepEqual(f.blocker.calls, []);
  f.broadcasts.length = 0;
  await f.call("phone:set-keep-awake", true);
  assert.deepEqual(f.blocker.calls, ["start:1"], "turning it on while already sharing holds a blocker");
  assert.ok(f.broadcasts.includes("phone:sharing-changed"));
  assert.deepEqual(await f.status(), { keepAwake: true, awake: true });
  await f.call("phone:set-keep-awake", true);
  assert.equal(f.blocker.starts(), 1, "saving the same value again starts nothing");
  await f.call("phone:set-keep-awake", false);
  assert.deepEqual(f.blocker.calls, ["start:1", "stop:1"]);
  assert.deepEqual(await f.status(), { keepAwake: false, awake: false });
  await f.call("phone:set-keep-awake", true);
  assert.deepEqual(f.blocker.calls, ["start:1", "stop:1", "start:2"]);
});

test("quitting releases the blocker at once, before the servers have finished closing", async t => {
  const f = await fixture(t, { remembered: true, keepAwake: true });
  await f.share();
  assert.deepEqual(f.blocker.calls, ["start:1"]);
  const quitting = f.beginQuit();
  assert.deepEqual(f.blocker.calls, ["start:1", "stop:1"], "released in the same tick as the quit request");
  await quitting;
  assert.deepEqual(f.blocker.calls, ["start:1", "stop:1"]);
});

test("closing the window that shares releases the blocker", async t => {
  const f = await fixture(t, { remembered: true, keepAwake: true });
  await f.share();
  assert.deepEqual(f.blocker.calls, ["start:1"]);
  f.sender.emit("destroyed");
  assert.deepEqual(f.blocker.calls, ["start:1", "stop:1"], "released before the connection has finished closing");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await f.status(), { keepAwake: true, awake: false });
});

test("a settings file that cannot be saved still leaves the blocker matching the setting in memory", async t => {
  const f = await fixture(t, { remembered: true, keepAwake: true });
  await f.share();
  assert.deepEqual(f.blocker.calls, ["start:1"]);
  const values = (f.settings as unknown as { values: Record<string, unknown> }).values;
  t.mock.method(f.settings, "set", (key: string, value: unknown) => { values[key] = value; throw new Error("disk full"); });
  await assert.rejects(f.call("phone:set-keep-awake", false), /disk full/);
  assert.deepEqual(f.blocker.calls, ["start:1", "stop:1"]);
  assert.deepEqual(await f.status(), { keepAwake: false, awake: false });
});

test("revoking the only live iPhone releases the blocker", async t => {
  const f = await fixture(t, { remembered: true, keepAwake: true });
  await f.share();
  const { remembered } = await f.call("phone:status", f.key) as { remembered: { id: string }[] };
  await f.call("phone:revoke", remembered[0]!.id);
  assert.deepEqual(f.blocker.calls, ["start:1", "stop:1"]);
  assert.deepEqual(await f.status(), { keepAwake: true, awake: false });
});

test("phone:set-keep-awake accepts only a boolean", async t => {
  const f = await fixture(t);
  for (const value of ["true", 1, null, undefined, {}])
    await assert.rejects(f.call("phone:set-keep-awake", value), /Choose whether to keep this Mac awake\./);
  assert.deepEqual(await f.status(), { keepAwake: false, awake: false });
});

test("a one-off pairing holds the blocker while it is live and phone:stop releases it", async t => {
  const address = lanAddresses()[0]?.address;
  if (!address) { t.skip("Requires a private LAN interface"); return; }
  const f = await fixture(t, { keepAwake: true });
  await f.call("phone:start", address, snapshot, f.key);
  assert.deepEqual(f.blocker.calls, ["start:1"]);
  assert.deepEqual(await f.status(), { keepAwake: true, awake: true });
  await f.call("phone:stop");
  assert.deepEqual(f.blocker.calls, ["start:1", "stop:1"]);
  assert.deepEqual(await f.status(), { keepAwake: true, awake: false });
  await f.call("phone:start", address, snapshot, f.key);
  assert.deepEqual(f.blocker.calls, ["start:1", "stop:1", "start:2"], "a second pairing gets a fresh blocker");
  await f.quit();
  assert.deepEqual(f.blocker.calls, ["start:1", "stop:1", "start:2", "stop:2"]);
});
