// Revision Mode, locked scene numbers and revision marks in the editor, on synthetic scripts.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ScreenplayDoc, deletionMarks, lockPages, moveScene, newRevisionSet, omitScene, pageLocks, paginate, parseFdx, plainText, revisedRanges,
  revisionState, setSceneNumbersLocked, updateRevisionState, writeFdx, type Paragraph,
} from "@screenplay/engine";
import * as Y from "yjs";

import { DocumentSession } from "../src/renderer/core/session.ts";
import { revisionDecorations, revisionStyles } from "../src/renderer/features/revisions/marks.ts";
import { trackSession } from "../src/renderer/features/revisions/tracking.ts";

function session(paragraphs: Paragraph[]): DocumentSession {
  const doc = new ScreenplayDoc();
  doc.load({ titlePage: [], paragraphs });
  const result = new DocumentSession(doc);
  result.undo.clear();
  return result;
}

function script(): Paragraph[] {
  return [
    { id: "h1", type: "sceneHeading", sceneId: "s1", sceneNumber: "1", runs: [{ text: "INT. KITCHEN - DAY" }] },
    { id: "a1", type: "action", runs: [{ text: "Nell pours coffee." }] },
    { id: "h2", type: "sceneHeading", sceneId: "s2", sceneNumber: "2", runs: [{ text: "EXT. YARD - DAY" }] },
    { id: "a2", type: "action", runs: [{ text: "The dog barks." }] },
    { id: "h3", type: "sceneHeading", sceneId: "s3", sceneNumber: "3", runs: [{ text: "INT. CAR - NIGHT" }] },
    { id: "a3", type: "action", runs: [{ text: "Rain." }] },
  ];
}

function startTracking(s: DocumentSession): void {
  s.edit(() => updateRevisionState(s.doc, (state) => {
    const set = newRevisionSet(state, { date: "10/30/26" });
    return { sets: [set], currentSetId: set.id, tracking: true };
  }));
  s.undo.clear();
}

test("typed text in Revision Mode takes the current set, and one undo removes text and mark together", () => {
  const s = session(script());
  const stop = trackSession(s);
  startTracking(s);
  s.edit(() => s.doc.insertText("a1", 4, " slowly"));
  const paragraph = s.doc.paragraph("a1");
  assert.equal(plainText(paragraph.runs), "Nell slowly pours coffee.");
  assert.deepEqual(revisedRanges(paragraph), [{ from: 4, to: 11, setId: "1" }]);
  assert.equal(s.undo.undoStack.length, 1, "the mark joined the typing's undo step");
  s.undo.undo();
  assert.equal(plainText(s.doc.paragraph("a1").runs), "Nell pours coffee.");
  assert.deepEqual(revisedRanges(s.doc.paragraph("a1")), []);
  stop();
});

test("revised typing patches the paragraph list instead of re-reading the whole script", () => {
  const s = session(script());
  const stop = trackSession(s);
  startTracking(s);
  s.doc.paragraphs();
  let reads = 0;
  const toDelta = s.doc.body.toDelta.bind(s.doc.body);
  s.doc.body.toDelta = (...args: Parameters<typeof toDelta>) => (reads++, toDelta(...args));
  for (const char of "slowly ") s.edit(() => s.doc.insertText("a1", 5 + "slowly ".indexOf(char), char));
  assert.equal(reads, 0);
  assert.deepEqual(revisedRanges(s.doc.paragraph("a1")), [{ from: 5, to: 12, setId: "1" }]);
  s.doc.body.toDelta = toDelta;
  stop();
});

test("with nothing to track, typing never makes Yjs work out the change's delta", () => {
  const s = session(script());
  const stop = trackSession(s);
  const computed: boolean[] = [];
  // Observers share the event; one registered after the tracker sees whether it read the delta.
  s.doc.body.observe((event) => computed.push((event as unknown as { _delta: unknown })._delta != null));
  s.edit(() => s.doc.insertText("a1", 0, "Then "));
  startTracking(s);
  s.edit(() => s.doc.insertText("a2", 0, "Far off, "));
  assert.deepEqual(computed, [false, true, true]);
  stop();
});

test("a paragraph joined onto the one before it takes its deletion marks along", () => {
  const s = session(script());
  const stop = trackSession(s);
  startTracking(s);
  s.edit(() => s.doc.deleteText("a2", 4, 4));
  assert.deepEqual(deletionMarks(s.doc.paragraph("a2")), [{ offset: 4, setId: "1" }]);
  // Backspace at the start of "The barks.": it joins the heading before it.
  s.edit(() => s.doc.mergeWithPrevious("a2"));
  const joined = s.doc.paragraph("h2");
  assert.equal(plainText(joined.runs), "EXT. YARD - DAYThe barks.");
  assert.deepEqual(deletionMarks(joined).map((mark) => mark.offset).sort((a, b) => a - b), [15, 19]);
  // Outside Revision Mode the marks still travel; the join itself leaves none.
  s.edit(() => updateRevisionState(s.doc, () => ({ tracking: false })));
  s.edit(() => s.doc.mergeWithPrevious("h2"));
  assert.deepEqual(deletionMarks(s.doc.paragraph("a1")).map((mark) => mark.offset).sort((a, b) => a - b), [33, 37]);
  stop();
});

test("text typed outside Revision Mode, and remote text, is not marked", () => {
  const s = session(script());
  const stop = trackSession(s);
  s.edit(() => s.doc.insertText("a1", 0, "Then "));
  assert.deepEqual(revisedRanges(s.doc.paragraph("a1")), []);
  startTracking(s);
  s.doc.ydoc.transact(() => s.doc.insertText("a2", 0, "Far off, "), "remote");
  assert.deepEqual(revisedRanges(s.doc.paragraph("a2")), []);
  stop();
});

test("deleting text leaves a deletion mark; pasting paragraphs marks their text but not their breaks", () => {
  const s = session(script());
  const stop = trackSession(s);
  startTracking(s);
  s.edit(() => s.doc.deleteText("a2", 4, 4));
  assert.equal(plainText(s.doc.paragraph("a2").runs), "The barks.");
  assert.deepEqual(deletionMarks(s.doc.paragraph("a2")), [{ offset: 4, setId: "1" }]);
  const [pasted] = s.edit(() => s.doc.insertParagraphsAt({ paragraphId: "a3", offset: 5 }, [
    { id: "x", type: "action", runs: [{ text: "Thunder." }] },
  ]));
  const added = s.doc.paragraph(pasted!);
  assert.deepEqual(revisedRanges(added), [{ from: 0, to: 8, setId: "1" }]);
  assert.equal(s.doc.validate().length, 0);
  stop();
});

test("with scene numbers locked, a deleted scene leaves an OMITTED heading and a new scene gets an A-number", () => {
  const s = session(script());
  const stop = trackSession(s);
  s.edit(() => setSceneNumbersLocked(s.doc, true));
  s.edit(() => {
    s.doc.deleteParagraph("h2");
    s.doc.deleteParagraph("a2");
  });
  const headings = () => s.doc.paragraphs().filter((p) => p.type === "sceneHeading").map((p) => `${p.sceneNumber} ${plainText(p.runs)}`);
  assert.deepEqual(headings(), ["1 INT. KITCHEN - DAY", "2 OMITTED", "3 INT. CAR - NIGHT"]);
  // Separate undo steps, as two edits a second apart would be.
  s.undo.stopCapturing();
  s.edit(() => s.doc.insertParagraph(2, { type: "sceneHeading", runs: [{ text: "INT. HALL - DAY" }] }));
  assert.deepEqual(headings(), ["1 INT. KITCHEN - DAY", "1A INT. HALL - DAY", "2 OMITTED", "3 INT. CAR - NIGHT"]);
  s.undo.undo();
  assert.deepEqual(headings(), ["1 INT. KITCHEN - DAY", "2 OMITTED", "3 INT. CAR - NIGHT"]);
  s.undo.undo();
  assert.deepEqual(headings(), ["1 INT. KITCHEN - DAY", "2 EXT. YARD - DAY", "3 INT. CAR - NIGHT"]);
  stop();
});

test("locked scenes: an empty heading takes no number and leaves no OMITTED; a heading retyped and back leaves none either", () => {
  const s = session(script());
  const stop = trackSession(s);
  s.doc.ydoc.transact(() => setSceneNumbersLocked(s.doc, true), "settings");
  const headings = () => s.doc.paragraphs().filter((p) => p.type === "sceneHeading").map((p) => `${p.sceneNumber ?? "-"} ${plainText(p.runs)}`);
  // Return after an action line, the new line passes through Scene Heading, then Backspace removes it.
  const id = s.edit(() => s.doc.splitParagraph("a2", plainText(s.doc.paragraph("a2").runs).length, "sceneHeading"));
  assert.deepEqual(headings(), ["1 INT. KITCHEN - DAY", "2 EXT. YARD - DAY", "- ", "3 INT. CAR - NIGHT"]);
  s.edit(() => s.doc.mergeWithPrevious(id));
  assert.deepEqual(headings(), ["1 INT. KITCHEN - DAY", "2 EXT. YARD - DAY", "3 INT. CAR - NIGHT"]);
  // Typed into, it gets its A-number; removed in the same sitting, it was never printed and leaves nothing.
  const hall = s.edit(() => s.doc.insertParagraph(4, { type: "sceneHeading" }));
  s.edit(() => s.doc.insertText(hall, 0, "INT. HALL - DAY"));
  assert.deepEqual(headings(), ["1 INT. KITCHEN - DAY", "2 EXT. YARD - DAY", "2A INT. HALL - DAY", "3 INT. CAR - NIGHT"]);
  s.edit(() => s.doc.deleteParagraph(hall));
  assert.deepEqual(headings(), ["1 INT. KITCHEN - DAY", "2 EXT. YARD - DAY", "3 INT. CAR - NIGHT"]);
  // A heading made action leaves an OMITTED placeholder; made a heading again, it takes the placeholder back.
  s.edit(() => s.doc.setType("h2", "action"));
  assert.deepEqual(headings(), ["1 INT. KITCHEN - DAY", "2 OMITTED", "3 INT. CAR - NIGHT"]);
  s.edit(() => s.doc.setType("h2", "sceneHeading"));
  assert.deepEqual(headings(), ["1 INT. KITCHEN - DAY", "2 EXT. YARD - DAY", "3 INT. CAR - NIGHT"]);
  assert.equal(s.doc.validate().length, 0);
  stop();
});

test("deletion marks: none where new text replaced the old or an OMITTED heading took a scene's place; marks follow their text", () => {
  const s = session(script());
  const stop = trackSession(s);
  startTracking(s);
  // Typing over a selection: the new text is revised, no deletion mark beside it.
  s.edit(() => {
    s.doc.deleteText("a1", 5, 5);
    s.doc.insertText("a1", 5, "spills");
  });
  assert.equal(plainText(s.doc.paragraph("a1").runs), "Nell spills coffee.");
  assert.deepEqual(revisedRanges(s.doc.paragraph("a1")), [{ from: 5, to: 11, setId: "1" }]);
  assert.deepEqual(deletionMarks(s.doc.paragraph("a1")), []);
  // A deleted scene with numbers locked: the OMITTED heading is the revision, the scene before it is untouched.
  s.doc.ydoc.transact(() => setSceneNumbersLocked(s.doc, true), "settings");
  s.edit(() => {
    s.doc.deleteParagraph("h2");
    s.doc.deleteParagraph("a2");
  });
  assert.deepEqual(deletionMarks(s.doc.paragraph("a1")), []);
  const omitted = s.doc.paragraphs().find((p) => plainText(p.runs) === "OMITTED")!;
  assert.deepEqual(revisedRanges(omitted), [{ from: 0, to: 7, setId: "1" }]);
  // Backspacing a word leaves one mark where it was; text typed before it later moves the mark along.
  for (let i = 0; i < 4; i++) s.edit(() => s.doc.deleteText("a3", 4 - i, 1));
  assert.equal(plainText(s.doc.paragraph("a3").runs), "R");
  assert.deepEqual(deletionMarks(s.doc.paragraph("a3")), [{ offset: 1, setId: "1" }]);
  s.doc.ydoc.transact(() => updateRevisionState(s.doc, () => ({ tracking: false })), "settings");
  s.edit(() => s.doc.insertText("a3", 0, "Hard r"));
  assert.deepEqual(deletionMarks(s.doc.paragraph("a3")), [{ offset: 7, setId: "1" }]);
  stop();
});

test("Omit Scene in Revision Mode marks the OMITTED heading, not the scene before it", () => {
  const s = session(script());
  const stop = trackSession(s);
  startTracking(s);
  s.edit(() => omitScene(s.doc, "s2"));
  assert.deepEqual(deletionMarks(s.doc.paragraph("a1")), []);
  const omitted = s.doc.paragraphs().find((p) => plainText(p.runs) === "OMITTED")!;
  assert.deepEqual([omitted.sceneNumber, revisedRanges(omitted)], ["2", [{ from: 0, to: 7, setId: "1" }]]);
  stop();
});

test("decorations: revised stretches, deletion marks, a paragraph class, and per-set styles", () => {
  const s = session(script());
  const stop = trackSession(s);
  startTracking(s);
  s.edit(() => s.doc.insertText("a1", 0, "Slowly, "));
  s.edit(() => s.doc.deleteText("a3", 0, 1));
  const state = revisionState(s.doc);
  const decorations = revisionDecorations({ paragraphs: s.doc.paragraphs() as Paragraph[] }, state);
  assert.deepEqual(decorations.map((d) => [d.paragraphId, d.className, d.from, d.to]), [
    ["a1", "rev-para rev-set-1", undefined, undefined],
    ["a1", "rev-text rev-set-1", 0, 8],
    ["a3", "rev-para rev-set-1", undefined, undefined],
    ["a3", "rev-del rev-set-1", 0, 1],
  ]);
  assert.equal(decorations[1]!.title, "Blue Rev. 10/30/26");
  assert.match(revisionStyles(state), /\.rev-set-1 \{ --rev-color: #C6EDFE; --rev-mark: "\*"; \}/);
  assert.match(revisionStyles(state), /\.editor-t-action \{ --rev-mark-x: calc\(7\.75 - var\(--editor-left, 1\.5\)\); \}/);
  assert.deepEqual(revisionDecorations({ paragraphs: s.doc.paragraphs() as Paragraph[] }, { ...state, showMarks: false }), []);
  stop();
});

test("a revision mark joins its edit's undo step however long other listeners take (Sol round 3, #8)", () => {
  const s = session(script());
  const stop = trackSession(s);
  startTracking(s);
  let first = true;
  // A listener that blocks for 700 ms on the first update, longer than the undo manager's capture timeout.
  const slow = () => {
    if (!first) return;
    first = false;
    const until = Date.now() + 700;
    while (Date.now() < until) { /* busy */ }
  };
  s.doc.ydoc.on("update", slow);
  try {
    s.edit(() => s.doc.insertText("a1", 0, "X"));
    assert.equal(first, false, "the slow listener ran");
    assert.deepEqual(revisedRanges(s.doc.paragraph("a1")), [{ from: 0, to: 1, setId: "1" }]);
    assert.equal(s.undo.undoStack.length, 1, "one undo step");
    s.undo.undo();
    assert.equal(plainText(s.doc.paragraph("a1").runs), "Nell pours coffee.");
    assert.deepEqual(revisedRanges(s.doc.paragraph("a1")), []);
    // A later, separate edit still gets its own step.
    s.undo.stopCapturing();
    s.edit(() => s.doc.insertText("a1", 0, "Y"));
    s.undo.stopCapturing();
    s.edit(() => s.doc.insertText("a3", 0, "Z"));
    assert.equal(s.undo.undoStack.length, 2);
  } finally {
    s.doc.ydoc.off("update", slow);
    stop();
  }
});

const FDX = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5">
  <Content>
    <Paragraph Type="Action" id="A"><Text>abcdefghij</Text></Paragraph>
    <Paragraph Type="Action" id="B"><Text>klmnopqrst</Text></Paragraph>
  </Content>
  <DeletedText>
    <DeletedTextLocation Offset="16" RevisionID="1"/>
  </DeletedText>
</FinalDraft>
`;

test("Final Draft's deletion marks follow typing before them, in their paragraph and the one above (Sol round 3, #7)", () => {
  const s = new DocumentSession(ScreenplayDoc.fromScript(parseFdx(FDX)), { format: "fdx" });
  s.undo.clear();
  const stop = trackSession(s);
  s.edit(() => s.doc.insertText("A", 0, "0123456789"));
  assert.deepEqual(deletionMarks(s.doc.paragraph("B")), [{ offset: 5, setId: "1" }]);
  s.edit(() => s.doc.insertText("B", 0, "++"));
  assert.deepEqual(deletionMarks(s.doc.paragraph("B")), [{ offset: 7, setId: "1" }]);
  // Counted the way Final Draft counts: A's 20 characters and its break, then 7 into B.
  assert.match(writeFdx(s.doc.toScript()), /<DeletedTextLocation Offset="28" RevisionID="1"\/>/);
  stop();
});

test("pages locked inside a paragraph and saved to FDX follow their text again after reopening", () => {
  const long = Array.from({ length: 300 }, (_, i) => `Sentence ${i + 1} is right here.`).join(" ");
  const first = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "h", type: "sceneHeading", runs: [{ text: "INT. HALL - NIGHT" }] },
    { id: "a", type: "action", runs: [{ text: long }] },
  ] });
  const locks = lockPages(first, paginate(first.toScript()));
  assert.ok(locks[1]!.offset > 0);

  const s = new DocumentSession(ScreenplayDoc.fromScript(parseFdx(writeFdx(first.toScript()))), { format: "fdx" });
  s.undo.clear();
  const stop = trackSession(s);
  assert.deepEqual(pageLocks(s.doc)!.map((lock) => [lock.paragraphId, lock.offset]), locks.map((lock) => [lock.paragraphId, lock.offset]));
  s.edit(() => s.doc.insertText("a", 0, "Inserted. "));
  assert.deepEqual(pageLocks(s.doc)!.slice(1).map((lock) => lock.offset), locks.slice(1).map((lock) => lock.offset + 10));
  s.edit(() => s.doc.insertText("a", 0, "Again. "));
  assert.deepEqual(pageLocks(s.doc)!.slice(1).map((lock) => lock.offset), locks.slice(1).map((lock) => lock.offset + 17));
  // Undo takes the anchoring back with the typing: the locks read from the FDX again, which fit the text again.
  s.undo.undo();
  assert.equal(plainText(s.doc.paragraph("a").runs), long);
  assert.deepEqual(pageLocks(s.doc)!.map((lock) => lock.offset), locks.map((lock) => lock.offset));
  stop();
});

test("Return splits a deletion mark off with the text after it; a moved scene keeps its marks (Sol round 4, P2 3)", () => {
  const s = new DocumentSession(ScreenplayDoc.fromScript(parseFdx(FDX)), { format: "fdx" });
  s.undo.clear();
  const stop = trackSession(s);
  assert.deepEqual(deletionMarks(s.doc.paragraph("B")), [{ offset: 5, setId: "1" }]);
  const added = s.edit(() => s.doc.splitParagraph("B", 2));
  assert.equal(plainText(s.doc.paragraph(added).runs), "mnopqrst");
  assert.deepEqual(deletionMarks(s.doc.paragraph("B")), []);
  assert.deepEqual(deletionMarks(s.doc.paragraph(added)), [{ offset: 3, setId: "1" }]);
  // A's 10 characters and break, "kl" and its break, then 3 into the new paragraph.
  assert.match(writeFdx(s.doc.toScript()), /<DeletedTextLocation Offset="17" RevisionID="1"\/>/);
  // Return exactly at a mark leaves it at the end of the first half; typing there leaves it before the typing.
  s.edit(() => s.doc.splitParagraph(added, 3));
  assert.deepEqual(deletionMarks(s.doc.paragraph(added)), [{ offset: 3, setId: "1" }]);
  s.edit(() => s.doc.insertText(added, 3, "XY"));
  assert.deepEqual(deletionMarks(s.doc.paragraph(added)), [{ offset: 3, setId: "1" }]);
  stop();

  const paragraphs: Paragraph[] = [
    { id: "h1", type: "sceneHeading", sceneId: "s1", runs: [{ text: "INT. KITCHEN - DAY" }] },
    { id: "a1", type: "action", runs: [{ text: "Nell pours coffee." }] },
    { id: "h2", type: "sceneHeading", sceneId: "s2", runs: [{ text: "EXT. YARD - DAY" }] },
    { id: "a2", type: "action", runs: [{ text: "The dog barks." }], fdx: { after: [{ name: "DeletedTextLocation", attrs: [["Offset", "4"], ["RevisionID", "1"]], children: [] }] } },
    { id: "h3", type: "sceneHeading", sceneId: "s3", runs: [{ text: "INT. CAR - NIGHT" }] },
    { id: "a3", type: "action", runs: [{ text: "Rain on the roof." }], fdx: { after: [{ name: "DeletedTextLocation", attrs: [["Offset", "9"], ["RevisionID", "1"]], children: [] }] } },
  ];
  const moved = session(paragraphs);
  const stopMoved = trackSession(moved);
  moved.edit(() => moveScene(moved.doc, "s2", null));
  assert.deepEqual(moved.doc.paragraphs().map((p) => p.id), ["h1", "a1", "h3", "a3", "h2", "a2"]);
  assert.deepEqual(deletionMarks(moved.doc.paragraph("a2")), [{ offset: 4, setId: "1" }], "the moved scene's mark stays on its text");
  assert.deepEqual(deletionMarks(moved.doc.paragraph("a3")), [{ offset: 9, setId: "1" }], "an unmoved paragraph's mark stays put");
  assert.deepEqual(deletionMarks(moved.doc.paragraph("a1")), []);
  moved.edit(() => moveScene(moved.doc, "s3", "s1"));
  assert.deepEqual(deletionMarks(moved.doc.paragraph("a2")), [{ offset: 4, setId: "1" }]);
  assert.deepEqual(deletionMarks(moved.doc.paragraph("a3")), [{ offset: 9, setId: "1" }]);
  stopMoved();
});

test("a locked page restored by Undo starts in the same place for co-writers with different undo histories (final review #7)", () => {
  const sentences = Array.from({ length: 180 }, (_, i) => `Sentence ${i + 1} is here.`).join(" ");
  const seed = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "h1", type: "sceneHeading", sceneId: "h1", runs: [{ text: "INT. ROOM - DAY" }] },
    { id: "p1", type: "action", runs: [{ text: sentences }] },
  ] });
  // A writes in the app (with Undo); B is a co-writer whose replica has no undo history.
  const ydoc = new Y.Doc();
  ydoc.clientID = 300;
  const a = new DocumentSession(new ScreenplayDoc(ydoc));
  a.doc.applyUpdate(seed.encodeState(), "remote");
  a.undo.clear();
  const stop = trackSession(a);
  const bdoc = new Y.Doc();
  bdoc.clientID = 200;
  const b = new ScreenplayDoc(bdoc);
  b.applyUpdate(seed.encodeState(), "remote");
  const sync = () => {
    for (let i = 0; i < 2; i++) {
      b.applyUpdate(Y.encodeStateAsUpdate(a.doc.ydoc, Y.encodeStateVector(b.ydoc)), "remote");
      a.doc.applyUpdate(Y.encodeStateAsUpdate(b.ydoc, Y.encodeStateVector(a.doc.ydoc)), "remote");
    }
  };
  a.edit(() => lockPages(a.doc, paginate(a.doc.toScript())));
  sync();
  const locked = pageLocks(a.doc)![1]!;
  assert.ok(locked.offset > 100);
  a.undo.stopCapturing();
  // A selects 40 characters around the page start, deletes them, and presses Undo.
  a.edit(() => a.doc.deleteText("p1", locked.offset - 20, 40));
  a.undo.undo();
  sync();
  assert.equal(a.doc.body.toString(), b.body.toString());
  const pages = (doc: ScreenplayDoc) => paginate(doc.toScript(), { locks: pageLocks(doc)! }).pages.map((page) => page.number);
  for (const doc of [a.doc, b, ScreenplayDoc.fromUpdate(a.doc.encodeState())]) {
    const lock = pageLocks(doc)![1]!;
    assert.deepEqual([lock.paragraphId, lock.offset], ["p1", locked.offset], "the page starts with the text it was locked on");
    assert.deepEqual(pages(doc), ["1", "2"]);
  }
  const position = (doc: ScreenplayDoc) => /<LockedPage[^>]*PageNumber="2"[^>]*\/>/.exec(writeFdx(doc.toScript()))?.[0];
  assert.equal(position(a.doc), position(b));
  // Redo deletes the text again; the redo stack survived the anchor move.
  assert.equal(a.undo.redoStack.length, 1);
  a.undo.redo();
  sync();
  assert.equal(pageLocks(a.doc)![1]!.offset, pageLocks(b)![1]!.offset);
  stop();
});

test("the first edit after reopening FDX, a scene move, keeps an interior locked page on its text (Sol round 4, P2 2)", () => {
  const long = Array.from({ length: 180 }, (_, i) => `Sentence ${i + 1} is right here.`).join(" ");
  const first = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "h1", type: "sceneHeading", sceneId: "h1", runs: [{ text: "INT. HALL - NIGHT" }] },
    { id: "a1", type: "action", runs: [{ text: long }] },
    { id: "h2", type: "sceneHeading", sceneId: "h2", runs: [{ text: "EXT. GARDEN - DAY" }] },
    { id: "a2", type: "action", runs: [{ text: "Birds." }] },
  ] });
  const locks = lockPages(first, paginate(first.toScript()));
  const interior = locks.find((lock) => lock.paragraphId === "a1" && lock.offset > 0)!;
  assert.ok(interior);

  const s = new DocumentSession(ScreenplayDoc.fromScript(parseFdx(writeFdx(first.toScript()))), { format: "fdx" });
  s.undo.clear();
  const stop = trackSession(s);
  s.edit(() => moveScene(s.doc, "h1", null));
  assert.deepEqual(s.doc.paragraphs().map((p) => p.id), ["h2", "a2", "h1", "a1"]);
  const after = pageLocks(s.doc)!.find((lock) => lock.number === interior.number)!;
  assert.deepEqual([after.paragraphId, after.offset], ["a1", interior.offset]);
  stop();
});

test("after Undo brings back a locked page's first text, Undo still takes back Lock Pages, for co-writers too", () => {
  const sentences = Array.from({ length: 180 }, (_, i) => `Sentence ${i + 1} is here.`).join(" ");
  const seed = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "h1", type: "sceneHeading", sceneId: "h1", runs: [{ text: "INT. ROOM - DAY" }] },
    { id: "p1", type: "action", runs: [{ text: sentences }] },
  ] });
  const a = new DocumentSession(ScreenplayDoc.fromUpdate(seed.encodeState()));
  a.undo.clear();
  const stop = trackSession(a);
  const b = ScreenplayDoc.fromUpdate(seed.encodeState());
  const sync = () => {
    b.applyUpdate(Y.encodeStateAsUpdate(a.doc.ydoc, Y.encodeStateVector(b.ydoc)), "remote");
    a.doc.applyUpdate(Y.encodeStateAsUpdate(b.ydoc, Y.encodeStateVector(a.doc.ydoc)), "remote");
  };
  a.edit(() => lockPages(a.doc, paginate(a.doc.toScript())));
  a.undo.stopCapturing();
  const locked = pageLocks(a.doc)![1]!;
  a.edit(() => a.doc.deleteText("p1", locked.offset - 20, 40));
  a.undo.stopCapturing();
  a.undo.undo();
  sync();
  for (const doc of [a.doc, b]) assert.equal(pageLocks(doc)![1]!.offset, locked.offset);
  // The next Undo is Lock Pages itself: the page start Undo restored must not stand in its way.
  a.undo.undo();
  sync();
  assert.equal(pageLocks(a.doc), null);
  assert.equal(pageLocks(b), null);
  a.undo.redo();
  sync();
  assert.equal(pageLocks(b)![1]!.offset, locked.offset);
  stop();
});

test("Return or a paste before an interior locked page, as the first edit after reopening FDX, keeps the page on its text", () => {
  const long = Array.from({ length: 180 }, (_, i) => `Sentence ${i + 1} is right here.`).join(" ");
  const first = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "h1", type: "sceneHeading", sceneId: "h1", runs: [{ text: "INT. HALL - NIGHT" }] },
    { id: "a1", type: "action", runs: [{ text: long }] },
  ] });
  const interior = lockPages(first, paginate(first.toScript())).find((lock) => lock.paragraphId === "a1" && lock.offset > 0)!;
  const startsWith = (doc: ScreenplayDoc) => {
    const lock = pageLocks(doc)!.find((page) => page.number === interior.number)!;
    return plainText(doc.paragraph(lock.paragraphId).runs).slice(lock.offset, lock.offset + 20);
  };
  const edits: ((doc: ScreenplayDoc) => unknown)[] = [
    (doc) => doc.splitParagraph("a1", 100),
    (doc) => doc.insertParagraphsAt({ paragraphId: "a1", offset: 100 }, [
      { id: "x", type: "action", runs: [{ text: "Pasted one." }] }, { id: "y", type: "action", runs: [{ text: "Pasted two." }] },
    ]),
  ];
  for (const edit of edits) {
    const s = new DocumentSession(ScreenplayDoc.fromScript(parseFdx(writeFdx(first.toScript()))), { format: "fdx" });
    s.undo.clear();
    const stop = trackSession(s);
    const before = startsWith(s.doc);
    s.edit(() => edit(s.doc));
    assert.equal(startsWith(s.doc), before);
    stop();
  }
});
