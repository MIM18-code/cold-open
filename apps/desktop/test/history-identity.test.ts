// Which Draft History folder a window uses. The ID sits in the document's synced metadata, so a co-writer or anyone
// who can write the sync folder can change it there. A window must keep using the ID its own file carried (or one it
// made), and the files it saves must carry that ID too, or the change would take effect the next time the file opens.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ScreenplayDoc } from "@screenplay/engine";
import * as Y from "yjs";

import { decodeNative, encodeNative } from "../src/renderer/core/fileformat.ts";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { historyId } from "../src/renderer/features/history/identity.ts";

const KEY = "history.documentId";
const MINE = "mine-history-id-0001";
const OTHER_SCRIPT = "another-scripts-id-0002";
const REMOTE = Symbol("co-writer");

function docWith(id?: string): ScreenplayDoc {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [{ id: "h", type: "sceneHeading", runs: [{ text: "INT. HALL - DAY" }] }] });
  if (id) doc.meta.set(KEY, id);
  return doc;
}

/** A co-writer (or a sync folder log) sets the history ID, and the change reaches this window as a remote update. */
function remoteSets(session: DocumentSession, id: string): void {
  const theirs = new Y.Doc();
  Y.applyUpdate(theirs, session.doc.encodeState());
  const before = Y.encodeStateVector(theirs);
  theirs.getMap("meta").set(KEY, id);
  session.doc.applyUpdate(Y.encodeStateAsUpdate(theirs, before), REMOTE);
}

const encode = (session: DocumentSession) => encodeNative(session.doc, session.name, session.historyId);

/** Open saved bytes the way the app opens a file. */
function reopen(bytes: Uint8Array, path: string): DocumentSession {
  const { doc, historyId: stored } = decodeNative(bytes);
  return new DocumentSession(doc, { path, historyId: stored });
}

test("a remote update cannot change which history a window uses", () => {
  const session = new DocumentSession(docWith(MINE), { path: "/scripts/hall.screenplay" });
  assert.equal(historyId(session), MINE);
  remoteSets(session, OTHER_SCRIPT);
  assert.equal(session.doc.meta.get(KEY), OTHER_SCRIPT, "the shared document does hold the co-writer's value");
  assert.equal(historyId(session), MINE);
  assert.equal(historyId(session, true), MINE);
});

test("the pin holds even when the remote update arrives before the window first asks for its ID", () => {
  const session = new DocumentSession(docWith(MINE), { path: "/scripts/hall.screenplay" });
  remoteSets(session, OTHER_SCRIPT);
  assert.equal(historyId(session, true), MINE);
});

test("a window with no ID of its own never adopts one that arrived from someone else", () => {
  // A guest's window starts empty and fills from the host; a script never saved as .screenplay has no ID either.
  const session = new DocumentSession(docWith(), { name: "Shared script" });
  remoteSets(session, OTHER_SCRIPT);
  assert.equal(historyId(session), null);
  const made = historyId(session, true);
  assert.ok(made && made !== OTHER_SCRIPT);
  assert.equal(historyId(session, true), made, "and it stays the same for the life of the window");
  // The other writer's ID is left alone in the shared document: two honest writers never overwrite each other.
  assert.equal(session.doc.meta.get(KEY), OTHER_SCRIPT);
});

test("a window that makes the first ID still writes it into the document, as before", () => {
  const session = new DocumentSession(docWith(), { path: "/scripts/new.screenplay" });
  assert.equal(historyId(session), null);
  const made = historyId(session, true);
  assert.equal(session.doc.meta.get(KEY), made);
  assert.equal(historyId(session), made);
});

test("a read-only window gets no ID", () => {
  const session = new DocumentSession(docWith(), { name: "Shared script" });
  session.readOnly = true;
  remoteSets(session, OTHER_SCRIPT);
  assert.equal(historyId(session, true), null);
});

test("the file a window saves carries the window's ID, so the change does not take effect on reopening", () => {
  const session = new DocumentSession(docWith(MINE), { path: "/scripts/hall.screenplay" });
  remoteSets(session, OTHER_SCRIPT);
  const reopened = reopen(encode(session), "/scripts/hall.screenplay");
  assert.equal(historyId(reopened), MINE);
  assert.equal(reopened.doc.paragraphs()[0]!.runs[0]!.text, "INT. HALL - DAY");
  // Saving changed nothing in the open document: writers with different IDs must not flip the shared value on every save.
  assert.equal(session.doc.meta.get(KEY), OTHER_SCRIPT);
});

test("a guest's saved copy carries the guest's ID, not the host's", () => {
  const session = new DocumentSession(docWith(), { name: "Shared script" });
  remoteSets(session, OTHER_SCRIPT);
  const made = historyId(session, true)!;
  const reopened = reopen(encode(session), "/scripts/copy.screenplay");
  assert.equal(historyId(reopened), made);
});

test("a window with no ID of its own writes no one else's ID into a file", () => {
  // A crash-recovery copy, or a read-only guest's saved copy: the window never made an ID, and the one in the shared
  // document is another writer's. Reopening the file must not start using it.
  const session = new DocumentSession(docWith(), { name: "Shared script" });
  remoteSets(session, OTHER_SCRIPT);
  const reopened = reopen(encode(session), "/scripts/recovered.screenplay");
  assert.equal(historyId(reopened), null);
  assert.equal(reopened.doc.paragraphs()[0]!.runs[0]!.text, "INT. HALL - DAY");
  assert.equal(session.doc.meta.get(KEY), OTHER_SCRIPT);
});

test("saving never adds anything to the script's shared state, whatever ID the document holds", () => {
  // The window's ID travels in the file's header. Writing it into the document on save, even on a copy, would put a
  // new change in the file, and another window merging that file would take it: two windows with their own IDs would
  // then overwrite the shared value, and grow the document, on every save.
  const state = (bytes: Uint8Array) => Y.encodeStateVector(decodeNative(bytes).doc.ydoc);
  const mine = new DocumentSession(docWith(MINE), { path: "/scripts/hall.screenplay" });
  assert.deepEqual(state(encode(mine)), Y.encodeStateVector(mine.doc.ydoc));
  remoteSets(mine, OTHER_SCRIPT);
  assert.deepEqual(state(encode(mine)), Y.encodeStateVector(mine.doc.ydoc));

  // Another window on the same script, with its own ID, merges the file this window saved: nothing changes for it.
  const theirs = new DocumentSession(ScreenplayDoc.fromUpdate(mine.doc.encodeState()), { path: "/scripts/hall.screenplay", historyId: OTHER_SCRIPT });
  const before = Y.encodeStateVector(theirs.doc.ydoc);
  theirs.doc.applyUpdate(decodeNative(encode(mine)).doc.encodeState(), REMOTE);
  assert.deepEqual(Y.encodeStateVector(theirs.doc.ydoc), before);
  assert.equal(historyId(theirs), OTHER_SCRIPT);
});

test("a file saved before IDs were kept in the header still opens with the ID in its document", () => {
  const old = encodeNative(docWith(MINE), "Hall");
  assert.equal(decodeNative(old).header.historyId, undefined);
  assert.equal(historyId(reopen(old, "/scripts/hall.screenplay")), MINE);
});
