// The folder sync service in the main process, with a stand-in for Electron: a quit that the writer cancels at a
// "Save changes?" prompt must leave folder sync running, a real quit must wait for every write, and a stale startup
// must not end a newer one.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import * as Y from "yjs";

import { SYNC } from "../src/shared/channels/sync.ts";
import type { Handler, ServiceContext } from "../src/main/context.ts";
import { parseLog } from "../src/main/sync/folder-log.ts";
import { registerFolderSync } from "../src/main/sync/folder-service.ts";
import { FolderSync } from "../src/main/sync/folder-sync.ts";

const temp = mkdtempSync(join(tmpdir(), "screenplay-sync-service-"));
// Closing every fake window stops its watchers, so a failing test does not keep the process alive.
const windows: (() => void)[] = [];
after(() => {
  for (const destroy of windows) destroy();
  rmSync(temp, { recursive: true, force: true });
});

function fakeContext() {
  const handlers = new Map<string, Handler>();
  const quitTasks: (() => unknown)[] = [];
  const values: Record<string, unknown> = {};
  const ctx = {
    handle: (channel: string, handler: Handler) => void handlers.set(channel, handler),
    settings: { get: (key: string) => values[key], set: (key: string, value: unknown) => void (values[key] = value) },
    isAllowedPath: () => true,
    onQuit: (task: () => unknown) => void quitTasks.push(task),
  } as unknown as ServiceContext;
  const destroyed: (() => void)[] = [];
  const errors: string[] = [];
  const sender = {
    id: 1,
    isDestroyed: () => false,
    send: (channel: string, _path: string, message?: unknown) => {
      if (channel === SYNC.folderError) errors.push(String(message));
    },
    once: (_event: string, listener: () => void) => void destroyed.push(listener),
  };
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender } as never, ...args);
  windows.push(() => destroyed.forEach((listener) => listener()));
  return { ctx, call, errors, quit: () => Promise.all(quitTasks.map((task) => task())), destroyWindow: () => destroyed.forEach((listener) => listener()) };
}

function readLog(ctx: ServiceContext, docPath: string): string {
  const bytes = readFileSync(join(docPath.replace(/\.screenplay$/, ".screenplay-sync"), `${ctx.settings.get("sync.deviceId")}.ylog`));
  const rebuilt = new Y.Doc();
  for (const record of parseLog(new Uint8Array(bytes)).records) Y.applyUpdate(rebuilt, record);
  return rebuilt.getText("body").toString();
}

function typing(text: string) {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  doc.getText("body").insert(0, text);
  return { doc, state: Y.encodeStateAsUpdate(doc), type: (at: number, more: string) => (doc.getText("body").insert(at, more), updates.at(-1)!) };
}

test("a cancelled quit flushes the log and keeps folder sync running", async () => {
  const { ctx, call, quit } = fakeContext();
  registerFolderSync(ctx);
  const path = join(temp, "Draft.screenplay");
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  doc.getText("body").insert(0, "Before quit.");
  const { subscription } = await call(SYNC.folderStart, path, Y.encodeStateAsUpdate(doc)) as { subscription: string };
  updates.length = 0;

  doc.getText("body").insert(12, " Typed just before Cmd+Q.");
  await call(SYNC.folderAppend, path, subscription, updates.pop()!);
  await quit();
  const log = () => {
    const name = readFileSync(join(temp, "Draft.screenplay-sync", `${ctx.settings.get("sync.deviceId")}.ylog`));
    const rebuilt = new Y.Doc();
    for (const record of parseLog(new Uint8Array(name)).records) Y.applyUpdate(rebuilt, record);
    return rebuilt.getText("body").toString();
  };
  assert.equal(log(), "Before quit. Typed just before Cmd+Q.");

  // The writer pressed Cancel at the prompt and keeps writing.
  doc.getText("body").insert(0, "Still synced. ");
  await call(SYNC.folderAppend, path, subscription, updates.pop()!);
  await quit();
  assert.equal(log(), "Still synced. Before quit. Typed just before Cmd+Q.");
  await call(SYNC.folderStop, path, subscription);
});

test("quitting right after the last window closes still writes its final change", async () => {
  const { ctx, call, quit, destroyWindow } = fakeContext();
  registerFolderSync(ctx);
  const path = join(temp, "Closing.screenplay");
  const script = typing("Before close.");
  const { subscription } = await call(SYNC.folderStart, path, script.state) as { subscription: string };
  await call(SYNC.folderAppend, path, subscription, script.type(13, " Typed just before Cmd+Q."));
  // The window goes away (its sync stops in the background) and the app quits at once.
  destroyWindow();
  await quit();
  assert.equal(readLog(ctx, path), "Before close. Typed just before Cmd+Q.");
});

test("quitting waits for a write the flush timer already started", async (t) => {
  const { ctx, call, quit } = fakeContext();
  registerFolderSync(ctx);
  const path = join(temp, "Timer.screenplay");
  const script = typing("Start.");
  const { subscription } = await call(SYNC.folderStart, path, script.state) as { subscription: string };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await call(SYNC.folderAppend, path, subscription, script.type(6, " Queued."));
  // The batch timer fires and its append is under way when the quit comes.
  t.mock.timers.tick(300);
  t.mock.timers.reset();
  await quit();
  assert.equal(readLog(ctx, path), "Start. Queued.");
  await call(SYNC.folderStop, path, subscription);
});

test("an old startup stopping does not end a newer one for the same document in the same window", async () => {
  const { ctx, call } = fakeContext();
  registerFolderSync(ctx);
  const path = join(temp, "Revert.screenplay");
  const script = typing("Original.");
  // Revert: the window starts sync for the reverted document while the first startup is still finishing.
  const first = call(SYNC.folderStart, path, script.state) as Promise<{ subscription: string }>;
  const second = call(SYNC.folderStart, path, script.state) as Promise<{ subscription: string }>;
  const [old, current] = await Promise.all([first, second]);
  assert.notEqual(old.subscription, current.subscription);
  await call(SYNC.folderStop, path, old.subscription);
  await call(SYNC.folderAppend, path, current.subscription, script.type(9, " After revert."));
  // A stale startup cannot write either.
  await call(SYNC.folderAppend, path, old.subscription, script.type(0, "STALE "));
  await call(SYNC.folderStop, path, current.subscription);
  const text = readLog(ctx, path);
  assert.ok(text.includes("After revert."), text);
});

test("edits from an append that failed are kept and written, in order, on the next try", async (t) => {
  const { ctx, call, quit } = fakeContext();
  registerFolderSync(ctx);
  const path = join(temp, "Full disk.screenplay");
  const script = typing("Start.");
  const { subscription } = await call(SYNC.folderStart, path, script.state) as { subscription: string };
  // The disk refuses every try of the first quit's flush, then has room.
  const append = FolderSync.prototype.append;
  const written: number[] = [];
  let failures = 3;
  t.mock.method(FolderSync.prototype, "append", function (this: FolderSync, updates: Uint8Array[]) {
    if (updates.length && failures-- > 0) return Promise.reject(new Error("ENOSPC"));
    if (updates.length) written.push(updates.length);
    return append.call(this, updates);
  });
  await call(SYNC.folderAppend, path, subscription, script.type(6, " Kept."));
  await quit();
  await call(SYNC.folderAppend, path, subscription, script.type(12, " Then more."));
  await quit();
  assert.equal(readLog(ctx, path), "Start. Kept. Then more.");
  assert.deepEqual(written, [1], "the kept edit and the new one go out together, once");
  await call(SYNC.folderStop, path, subscription);
});

test("the last window closing retries its final write a few times, and quit does too", async (t) => {
  const append = FolderSync.prototype.append;
  let failures = 0;
  t.mock.method(FolderSync.prototype, "append", function (this: FolderSync, updates: Uint8Array[]) {
    if (updates.length && failures-- > 0) return Promise.reject(new Error("EIO"));
    return append.call(this, updates);
  });
  // Closing: the entry is gone before its final flush, so only that flush can write the edit.
  const closing = fakeContext();
  registerFolderSync(closing.ctx);
  const closed = join(temp, "Closed.screenplay");
  const first = typing("Start.");
  const one = await closing.call(SYNC.folderStart, closed, first.state) as { subscription: string };
  await closing.call(SYNC.folderAppend, closed, one.subscription, first.type(6, " Last edit."));
  failures = 1;
  closing.destroyWindow();
  await closing.quit();
  assert.equal(readLog(closing.ctx, closed), "Start. Last edit.");
  // Quitting with the window still open.
  const open = fakeContext();
  registerFolderSync(open.ctx);
  const kept = join(temp, "Quit.screenplay");
  const second = typing("Start.");
  const two = await open.call(SYNC.folderStart, kept, second.state) as { subscription: string };
  await open.call(SYNC.folderAppend, kept, two.subscription, second.type(6, " At quit."));
  failures = 1;
  await open.quit();
  assert.equal(readLog(open.ctx, kept), "Start. At quit.");
  await open.call(SYNC.folderStop, kept, two.subscription);
});

test("a sync folder replaced by a link reports one error and does not spin a retry loop", async (t) => {
  const { ctx, call, errors } = fakeContext();
  registerFolderSync(ctx);
  const path = join(temp, "Broken.screenplay");
  const script = typing("Start.");
  const { subscription } = await call(SYNC.folderStart, path, script.state) as { subscription: string };
  const folder = path.replace(/\.screenplay$/, ".screenplay-sync");
  rmSync(folder, { recursive: true, force: true });
  symlinkSync(join(temp, "missing-target"), folder);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  await call(SYNC.folderAppend, path, subscription, script.type(6, " Edit."));
  t.mock.timers.tick(300);
  // Let the async flush settle, then advance past several 5-second retry intervals.
  t.mock.timers.reset();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(errors.length, 1);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.timers.tick(20_000);
  t.mock.timers.reset();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(errors.length, 1);
  await call(SYNC.folderStop, path, subscription);
});
