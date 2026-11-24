// A session on text with no line break (one writer deleted every paragraph while another typed; see "Text with no
// line break" in the engine's doc.ts): the first edit gives it a line break, apart from the edit itself.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ScreenplayDoc, changeScriptNote, deletionMarks, newRevisionSet, plainText, scriptNotes, updateRevisionState } from "@screenplay/engine";

import { DocumentSession } from "../src/renderer/core/session.ts";
import { trackSession } from "../src/renderer/features/revisions/tracking.ts";

/** A session whose script is " world" with no line break, and the ID that text is read with. */
function open(): { s: DocumentSession; id: string } {
  const doc = new ScreenplayDoc();
  doc.load({ titlePage: [], paragraphs: [{ id: "p", type: "action", runs: [{ text: " world" }] }] });
  // As a co-writer's deletion of the paragraph leaves it when this writer's typing arrives after.
  doc.ydoc.transact(() => doc.body.delete(0, 1), "peer");
  assert.equal(doc.body.toString(), " world");
  const s = new DocumentSession(doc);
  s.undo.clear();
  return { s, id: doc.paragraphs()[0]!.id };
}

test("undoing the first edit of text with no line break leaves its line break, its ID and a note on it", () => {
  const { s, id } = open();
  // A note a co-writer put on "or", which this writer does not touch.
  s.doc.ydoc.transact(() => changeScriptNote(s.doc, null, { text: "Check.", author: "", color: "" }, { from: { paragraphId: id, offset: 2 }, to: { paragraphId: id, offset: 4 } }), "peer");
  assert.equal(scriptNotes(s.doc)[0]!.state, "anchored");
  s.edit(() => s.doc.deleteText(id, 0, 1));
  assert.equal(plainText(s.doc.paragraph(id).runs), "world");
  s.undo.undo();
  // The first character comes back as a new one; the ID, made from the old one, is on the line break by now.
  assert.deepEqual(s.doc.paragraphs().map((p) => [p.id, plainText(p.runs)]), [[id, " world"]]);
  assert.equal(scriptNotes(s.doc)[0]!.state, "anchored");
  assert.equal(s.doc.body.toString(), "\n world");
  // Nothing more to undo: the line break is not an edit.
  assert.equal(s.undo.undoStack.length, 0);
  s.undo.redo();
  assert.deepEqual(s.doc.paragraphs().map((p) => [p.id, plainText(p.runs)]), [[id, "world"]]);
});

test("in Revision Mode, deleting the first character as the first edit of text with no line break leaves a deletion mark there", () => {
  const { s, id } = open();
  s.doc.ydoc.transact(() => updateRevisionState(s.doc, (state) => {
    const set = newRevisionSet(state, { date: "10/30/26" });
    return { sets: [set], currentSetId: set.id, tracking: true };
  }), "peer");
  const stop = trackSession(s);
  s.edit(() => s.doc.deleteText(id, 0, 1));
  assert.equal(plainText(s.doc.paragraph(id).runs), "world");
  assert.deepEqual(deletionMarks(s.doc.paragraph(id)), [{ offset: 0, setId: "1" }]);
  stop();
});
