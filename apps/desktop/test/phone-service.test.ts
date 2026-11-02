import { signEnvelope } from "./phone-signing.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTakesFile, register } from "../src/main/services/phone.ts";
import type { Handler, ServiceContext } from "../src/main/context.ts";
import { PhoneDevices } from "../src/main/phone/devices.ts";
import { PhoneInboxStore } from "../src/main/phone/inbox.ts";
import { phonePathKey } from "../src/main/phone/identity.ts";
import { Settings } from "../src/main/settings-store.ts";

test("window-owned inbox keys gate remembered devices, revocation and review, and state never reaches the renderer", async () => {
  const root = await mkdtemp(join(tmpdir(), "phone-service-"));
  const firstPath = join(root, "First.screenplay"), secondPath = join(root, "Second.screenplay");
  const firstKey = phonePathKey(firstPath), secondKey = phonePathKey(secondPath);
  const devices = new PhoneDevices(join(root, "phone-devices.json")); await devices.load();
  const { device, token } = await devices.create(firstKey, "100.114.165.59", "mac.tail123.ts.net");
  const store = new PhoneInboxStore(join(root, "phone-inbox"));
  const item = { id: "receipt-123456789", kind: "note" as const, text: "Private note.", paragraphId: "p",
    sourceText: "Quote.", cueId: "", revision: "r1", created: new Date().toISOString() };
  await devices.receive(device.id, firstKey, item, store);
  const handlers = new Map<string, Handler>(), quitting: (() => unknown)[] = [];
  const broadcasts: { channel: string; args: unknown[] }[] = [];
  const settings = new Settings(join(root, "settings.json"));
  const ctx = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler), settings,
    paths: { userData: root, repoRoot: root, appRoot: root },
    broadcast: (channel: string, ...args: unknown[]) => broadcasts.push({ channel, args }), send: () => {},
    isAllowedPath: (path: string) => [firstPath, secondPath].includes(path),
    onQuit: (callback: () => unknown) => quitting.push(callback), windowOf: () => ({ isDestroyed: () => false }),
  } as unknown as ServiceContext;
  const sender = (id: number) => Object.assign(new EventEmitter(), { id, isDestroyed: () => false });
  const first = sender(1), second = sender(2);
  const call = (who: typeof first, channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: who } as never, ...args);
  register(ctx, { clipboard: {}, dialog: { showMessageBox: async () => ({ response: 1 }) } } as never, async () => null,
    async () => ({ installed: true, running: true, magicDns: false, https: false }));
  try {
    await call(first, "phone:path-key", firstPath);
    await call(second, "phone:path-key", secondPath);
    assert.throws(() => call(second, "phone:path-key", "/not-open.screenplay"), /Open the script/);
    await assert.rejects(async () => call(second, "phone:claim-key", firstKey), /Invalid inbox/);
    const own = await call(first, "phone:status", firstKey) as any;
    const guessed = await call(second, "phone:status", firstKey) as any;
    assert.equal(own.inbox.length, 1); assert.equal(own.remembered[0].id, device.id);
    assert.deepEqual(own.tailscale, { installed: true, running: true, magicDns: false, https: false });
    assert.deepEqual(guessed.inbox, []); assert.deepEqual(guessed.remembered, []);
    for (const secret of [token, device.tokenHash, device.writerKey, root]) assert.ok(!JSON.stringify(own).includes(secret));
    assert.deepEqual(settings.all(), {});
    await assert.rejects(async () => call(second, "phone:acknowledge", firstKey, item.id), /Invalid inbox/);
    await assert.rejects(async () => call(second, "phone:revoke", device.id), /Open the paired script/);
    await assert.rejects(async () => call(second, "phone:resume", firstKey, { title: "x", revision: "r1", cues: [] }), /Open the script/);
    await call(second, "phone:clear-old-inboxes", secondKey);
    assert.equal((await store.list(firstKey)).length, 1, "Remembered script inboxes survive cleanup while closed.");
    await call(first, "phone:resume", firstKey, { title: "First Draft", revision: "r1", cues: [] });
    const takesPath = join(root, "Cold Open takes 2026-10-31.coldopentakes");
    await writeFile(takesPath, JSON.stringify({ v: 1, deviceId: device.id, scriptId: firstKey, takes: [
      signEnvelope({ deviceId: device.id, scriptId: firstKey, id: "receipt-123456790", kind: "note",
        text: "AirDropped note.", paragraphId: "p", sourceText: "Quote." }, device.tokenHash),
    ] }));
    assert.deepEqual(await openTakesFile(takesPath), { added: 1, title: "First Draft", scriptId: firstKey });
    assert.equal((await store.list(firstKey)).length, 2);
    assert.ok(broadcasts.some(b => b.channel === "phone:takes-imported" && (b.args[0] as any).added === 1));
    assert.equal((await openTakesFile(takesPath)).added, 0, "Receipts deduplicate across imports.");
    await assert.rejects(async () => call(first, "phone:set-port", 8080), /Revoke remembered/);
    await assert.rejects(async () => call(first, "phone:set-port", 80), /1024/);
    await call(first, "phone:acknowledge", firstKey, item.id, "ignored", device.id);
    await call(first, "phone:revoke", device.id);
    const saved = new PhoneDevices(devices.path); await saved.load();
    await call(first, "phone:set-port", 4457);
    assert.equal(settings.get("phone.port"), 4457);
    assert.equal(saved.device(device.id)?.revoked, true);
    assert.equal(saved.decisions(device.id)[item.id]?.outcome, "ignored");
  } finally {
    await Promise.all(quitting.map(fn => fn())); await rm(root, { recursive: true, force: true });
  }
});

test("cold-launch takes wait for their renderer's script report and refuse after 15 seconds", async t => {
  const root = await mkdtemp(join(tmpdir(), "phone-cold-launch-"));
  const path = join(root, "Draft.fountain"), key = phonePathKey(path);
  const devices = new PhoneDevices(join(root, "phone-devices.json"));
  const { device } = await devices.create(key, "127.0.0.1");
  const takesPath = join(root, "cold.coldopentakes");
  await writeFile(takesPath, JSON.stringify({ v: 1, deviceId: device.id, scriptId: key, takes: [
    signEnvelope({ deviceId: device.id, scriptId: key, id: "cold-receipt-001", kind: "note",
      text: "Keep this.", paragraphId: "old", sourceText: "Passage." }, device.tokenHash),
  ] }));
  const handlers = new Map<string, Handler>(), quitting: (() => unknown)[] = [];
  const ctx = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    paths: { userData: root }, settings: new Settings(join(root, "settings.json")),
    broadcast() {}, send() {}, isAllowedPath: (candidate: string) => candidate === path,
    onQuit: (callback: () => unknown) => quitting.push(callback), windowOf: () => ({}),
  } as unknown as ServiceContext;
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender } as never, ...args);
  register(ctx, { clipboard: {}, dialog: {} } as never, async () => null);
  try {
    await call("phone:path-key", path);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const timeout = globalThis.setTimeout;
    let waiting: (() => void) | undefined;
    t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
      const timer = timeout(...args);
      if (args[1] === 15000) waiting?.();
      return timer;
    });
    const waitUntilQueued = () => new Promise<void>(resolve => { waiting = resolve; });
    let queued = waitUntilQueued();
    let settled = false;
    const pending = openTakesFile(takesPath).finally(() => { settled = true; });
    void pending.catch(() => {});
    await Promise.race([queued, pending]);
    assert.equal(settled, false);
    assert.equal((await new PhoneInboxStore(join(root, "phone-inbox")).list(key)).length, 0);
    // A different restored window reporting first must not consume the file.
    const other = Object.assign(new EventEmitter(), { id: 2, isDestroyed: () => false });
    const otherKey = "9ae39062-ef1d-43d1-af6f-ec5d408e3453";
    await handlers.get("phone:claim-key")!({ sender: other } as never, otherKey);
    await handlers.get("phone:resume")!({ sender: other } as never, otherKey,
      { title: "Other", revision: "r1", cues: [] });
    assert.equal(settled, false);
    await call("phone:path-key", path);
    await call("phone:resume", key, { title: "Draft", revision: "r1", cues: [] });
    assert.equal((await pending).added, 1);
    await call("phone:detach");
    queued = waitUntilQueued();
    const refused = openTakesFile(takesPath);
    const refusal = assert.rejects(refused, /Open the script these takes belong to/);
    await queued;
    t.mock.timers.tick(15000);
    await refusal;
    await call("phone:path-key", path);
    await call("phone:resume", key, { title: "Draft", revision: "r1", cues: [] });
    assert.equal((await openTakesFile(takesPath)).added, 0, "The retry finds the earlier receipt.");
  } finally {
    await Promise.all(quitting.map(fn => fn()));
    await rm(root, { recursive: true, force: true });
  }
});
