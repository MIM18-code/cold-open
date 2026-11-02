// The renderer side of folder sync, against a fake main process: what the window sends to the log while folder
// sync starts, and the state it shows when it moves from one document to the next.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { SYNC } from "../src/shared/channels/sync.ts";
import { DocumentSession } from "../src/renderer/core/session.ts";

type Handler = (...args: any[]) => unknown;

const handlers = new Map<string, Handler>();
(globalThis as any).window = {
  desktop: {
    invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)?.(...args),
    on: () => () => undefined,
    spelling: { isMisspelled: () => false, suggestions: () => [], addToDictionary: () => undefined },
    platform: "darwin",
  },
};
// Loaded by URL after the fake bridge exists; the renderer module reads window.desktop when it loads.
const { FolderSyncClient } = await import(new URL("../src/renderer/features/collab/folder.ts", import.meta.url).href);

function savedSession(path: string, text: string): DocumentSession {
  const session = DocumentSession.untitled();
  const id = session.doc.toScript().paragraphs[0]!.id;
  session.edit(() => session.doc.insertText(id, 0, text));
  session.markSaved(path, "screenplay", "Draft");
  return session;
}

test("changes typed while folder sync starts still reach the log", async () => {
  const session = savedSession("/scripts/Draft.screenplay", "INT. LAB - NIGHT");
  const app = { session, toast: () => undefined };
  const id = session.doc.toScript().paragraphs[0]!.id;
  let started: Uint8Array | null = null;
  const appended: Uint8Array[] = [];
  handlers.set(SYNC.folderEnabled, () => true);
  handlers.set(SYNC.folderStart, async (_path: string, state: Uint8Array) => {
    started = state;
    // The writer keeps typing while the main process creates the folder and reads the other logs.
    session.edit(() => session.doc.insertText(id, 16, " - LATER"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { folder: "/scripts/Draft.screenplay-sync", deviceId: "device-aaaa", subscription: "sub-1", updates: [] };
  });
  handlers.set(SYNC.folderAppend, (_path: string, _subscription: string, update: Uint8Array) => void appended.push(update));
  handlers.set(SYNC.folderStop, () => undefined);

  const client = new FolderSyncClient(app, () => undefined);
  client.watch(session);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(client.state.active, true);
  session.edit(() => session.doc.insertText(id, 0, "1. "));
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Another device rebuilds the script from the log alone.
  const other = new Y.Doc();
  Y.applyUpdate(other, started!);
  for (const update of appended) Y.applyUpdate(other, update);
  assert.equal(other.getText("body").toString(), session.doc.ydoc.getText("body").toString());
  await client.stop();
});

test("moving to another synced document shows folder sync as on, whichever reply comes first", async () => {
  const first = savedSession("/scripts/One.screenplay", "ONE");
  const second = savedSession("/scripts/Two.screenplay", "TWO");
  const app = { session: first, toast: () => undefined };
  handlers.set(SYNC.folderEnabled, () => true);
  handlers.set(SYNC.folderStart, async (path: string) => ({ folder: `${path}-sync`, deviceId: "device-aaaa", subscription: path, updates: [] }));
  handlers.set(SYNC.folderAppend, () => undefined);
  // Stopping the old document's sync is slow (it flushes to disk); starting the new one is quick.
  handlers.set(SYNC.folderStop, () => new Promise((resolve) => setTimeout(resolve, 40)));

  const client = new FolderSyncClient(app, () => undefined);
  client.watch(first);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.state.folder, "/scripts/One.screenplay-sync");
  app.session = second;
  client.watch(second);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(client.state.active, true);
  assert.equal(client.state.folder, "/scripts/Two.screenplay-sync");
  await client.stop();
});

test("Revert while folder sync starts keeps the reverted document synced", async () => {
  const path = "/scripts/Revert.screenplay";
  const original = savedSession(path, "ORIGINAL");
  const app = { session: original, toast: () => undefined };
  // A stand-in for the main process: subscriptions by ID; appends and stops must name a live one.
  const live = new Map<string, string>();
  const accepted: Uint8Array[] = [];
  let starts = 0;
  handlers.set(SYNC.folderEnabled, () => true);
  handlers.set(SYNC.folderStart, async (startPath: string) => {
    const subscription = `sub-${++starts}`;
    live.set(subscription, startPath);
    // The first startup (the document before Revert) is slow; the reverted document's is quick.
    await new Promise((resolve) => setTimeout(resolve, starts === 1 ? 40 : 5));
    return { folder: `${startPath}-sync`, deviceId: "device-aaaa", subscription, updates: [] };
  });
  handlers.set(SYNC.folderAppend, (appendPath: string, subscription: unknown, update: unknown) => {
    if (typeof subscription === "string" && live.get(subscription) === appendPath && update instanceof Uint8Array) accepted.push(update);
  });
  handlers.set(SYNC.folderStop, (stopPath: string, subscription?: string) => {
    for (const [id, held] of [...live]) if (held === stopPath && (subscription === undefined || id === subscription)) live.delete(id);
  });

  const client = new FolderSyncClient(app, () => undefined);
  client.watch(original);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Revert: a new session for the same file replaces the window's document.
  const reverted = savedSession(path, "REVERTED");
  app.session = reverted;
  client.watch(reverted);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(client.state.active, true);
  assert.deepEqual([...live.keys()], ["sub-2"]);
  const id = reverted.doc.toScript().paragraphs[0]!.id;
  reverted.edit(() => reverted.doc.insertText(id, 0, "AFTER "));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(accepted.length, 1);
  await client.stop();
  assert.equal(live.size, 0);
});


test("failed local appends remain visible and retry sends the complete current draft", async () => {
  const session = savedSession("/scripts/Retry.screenplay", "INT. LAB - NIGHT");
  const app = { session, toast: () => undefined };
  const snapshots: Uint8Array[] = [];
  handlers.set(SYNC.folderEnabled, () => true);
  handlers.set(SYNC.folderStart, (_path: string, state: Uint8Array) => { snapshots.push(state); return { folder:"/scripts/Retry.screenplay-sync", subscription:`sub-${snapshots.length}`, deviceId:"test", updates:[] }; });
  handlers.set(SYNC.folderStop, () => undefined);
  handlers.set(SYNC.folderAppend, () => { throw new Error("disk unavailable"); });
  const client = new FolderSyncClient(app, () => undefined); client.watch(session);
  await new Promise(r => setTimeout(r, 10));
  const id = session.doc.paragraphs()[0]!.id;
  session.edit(() => session.doc.insertText(id, 0, "LATER "));
  await new Promise(r => setTimeout(r, 10));
  assert.match(client.state.error ?? "", /disk unavailable/);
  handlers.set(SYNC.folderAppend, () => undefined);
  session.edit(() => session.doc.insertText(id, 0, "MUCH "));
  await new Promise(r => setTimeout(r, 10));
  assert.match(client.state.error ?? "", /disk unavailable/);
  await client.retry(session);
  assert.equal(client.state.error, null);
  const rebuilt = new Y.Doc(); Y.applyUpdate(rebuilt, snapshots.at(-1)!);
  assert.equal(rebuilt.getText("body").toString(), session.doc.ydoc.getText("body").toString());
  await client.stop(); rebuilt.destroy(); session.destroy();
});
