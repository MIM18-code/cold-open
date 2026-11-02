import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Handler, ServiceContext } from "../src/main/context.ts";
import { VoiceModelManager } from "../src/main/models/voice-manager.ts";
import { register } from "../src/main/services/table-read.ts";
import { ReaderRuntime } from "../src/main/tts/runtime.ts";
import { TABLE_READ } from "../src/shared/channels/table-read.ts";

test("pack mutations broadcast through main and removal invalidates every window before notifying", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "voice-service-"));
  const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", { value: root, configurable: true });
  const handlers = new Map<string, Handler>(), broadcasts: string[] = [], invalidated: ReaderRuntime[] = [];
  const deleting = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  let quit: (() => unknown) | undefined;
  const ctx = {
    paths: { userData: root, repoRoot: root },
    handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); },
    broadcast: (channel: string) => { broadcasts.push(channel); if (channel === TABLE_READ.modelsChanged) assert.equal(invalidated.length, 2); },
    onQuit: (task: () => unknown) => { quit = task; },
  } as unknown as ServiceContext;
  t.mock.method(VoiceModelManager.prototype, "states", async () => []);
  t.mock.method(ReaderRuntime.prototype, "status", async () => ({ cacheBytes: 0, engines: [] }));
  t.mock.method(VoiceModelManager.prototype, "remove", async () => { started.resolve(); await deleting.promise; });
  t.mock.method(ReaderRuntime.prototype, "invalidatePack", function (this: ReaderRuntime, id: string) {
    assert.equal(id, "phonon"); invalidated.push(this);
  });
  try {
    register(ctx);
    const sender = (id: number) => ({ sender: { id, once: () => {} } }) as never;
    await handlers.get(TABLE_READ.status)!(sender(1));
    await handlers.get(TABLE_READ.status)!(sender(2));
    const removing = handlers.get(TABLE_READ.remove)!(sender(1), "phonon");
    await started.promise;
    assert.deepEqual(broadcasts, []);
    deleting.resolve(); await removing;
    assert.equal(new Set(invalidated).size, 2);
    assert.deepEqual(broadcasts, [TABLE_READ.modelsChanged]);
    // Failed or cancelled installs can leave resumable files, so those changes are broadcast too.
    t.mock.method(ReaderRuntime.prototype, "checkRequirements", () => {});
    t.mock.method(VoiceModelManager.prototype, "install", async () => { throw new Error("cancelled download"); });
    await assert.rejects(async () => handlers.get(TABLE_READ.install)!(sender(1), "phonon", true), /cancelled/);
    assert.deepEqual(broadcasts, [TABLE_READ.modelsChanged, TABLE_READ.modelsChanged]);
    assert.throws(() => handlers.get(TABLE_READ.prepare)!(sender(1), "qwen", true, true, true), /Invalid voice loading/);
  } finally {
    deleting.resolve(); await quit?.();
    if (resources) Object.defineProperty(process, "resourcesPath", resources);
    else Reflect.deleteProperty(process, "resourcesPath");
    await rm(root, { recursive: true, force: true });
  }
});

test("quit awaits disposal already started by a destroyed window", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "voice-service-"));
  const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", { value: root, configurable: true });
  const handlers = new Map<string, Handler>();
  const cleanup = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  let quit: (() => unknown) | undefined, destroyed: (() => void) | undefined, cleaned = false;
  const ctx = {
    paths: { userData: root, repoRoot: root },
    handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); },
    onQuit: (task: () => unknown) => { quit = task; },
  } as unknown as ServiceContext;
  t.mock.method(ReaderRuntime.prototype, "status", async () => ({ cacheBytes: 0, engines: [] }));
  t.mock.method(ReaderRuntime.prototype, "discardDesign", async () => {
    started.resolve(); await cleanup.promise; cleaned = true;
  });
  try {
    register(ctx);
    const sender = { id: 1, once: (_event: string, listener: () => void) => { destroyed = listener; } };
    await handlers.get(TABLE_READ.status)!({ sender } as never);
    destroyed!(); await started.promise;
    let quitFinished = false;
    const quitting = Promise.resolve(quit!()).then(() => { quitFinished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(quitFinished, false, "quit must wait for the removed runtime's cleanup");
    cleanup.resolve(); await quitting;
    assert.equal(cleaned, true);
  } finally {
    cleanup.resolve(); await quit?.();
    if (resources) Object.defineProperty(process, "resourcesPath", resources);
    else Reflect.deleteProperty(process, "resourcesPath");
    await rm(root, { recursive: true, force: true });
  }
});
