import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { ScreenplayDoc, moveScenes, moveSection, plainText, strandedByMove, strandedMoveRange, structuralMoveScene, type StructuralMoveConflict } from "../src/index.ts";

function pair(reload = false) {
  let a = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "act", type: "section", depth: 1, runs: [{ text: "ACT ONE" }] },
    ...["a", "b", "c"].flatMap(id => [
      { id, sceneId: id, type: "sceneHeading" as const, runs: [{ text: `INT. ${id.toUpperCase()} - DAY` }] },
      { id: `${id}-text`, type: "action" as const, runs: [{ text: `${id.toUpperCase()} text.` }] },
    ]),
    { id: "act2", type: "section", depth: 1, runs: [{ text: "ACT TWO" }] },
  ] });
  // Leave old text and formatting tombstones in an unchanged paragraph, then exercise GC serialization.
  a.insertText("a-text", 2, "discard", { bold: true });
  a.deleteText("a-text", 2, 7);
  if (reload) { const old = a; a = ScreenplayDoc.fromUpdate(Y.encodeStateAsUpdate(old.ydoc)); old.ydoc.destroy(); }
  const b = ScreenplayDoc.fromUpdate(Y.encodeStateAsUpdate(a.ydoc));
  const noticesA: StructuralMoveConflict[] = [], noticesB: StructuralMoveConflict[] = [];
  for (const [doc, notices] of [[a, noticesA], [b, noticesB]] as const) doc.body.observe((_event, transaction) => {
    const before = Y.encodeStateAsUpdate(doc.ydoc);
    const detected = strandedByMove(doc, transaction);
    assert.deepEqual(strandedByMove(doc, transaction), detected, "detection is deterministic");
    assert.deepEqual(Y.encodeStateAsUpdate(doc.ydoc), before, "detection never writes shared state");
    notices.push(...detected);
  });
  const sync = (typistFirst = false) => {
    if (typistFirst) { b.applyUpdate(a.encodeState(), "net"); a.applyUpdate(b.encodeState(), "net"); }
    else { a.applyUpdate(b.encodeState(), "net"); b.applyUpdate(a.encodeState(), "net"); }
    a.applyUpdate(b.encodeState(), "net"); b.applyUpdate(a.encodeState(), "net");
    assert.deepEqual(a.toScript(), b.toScript());
    assert.ok(![...a.meta.keys(), ...b.meta.keys()].some(key => key.startsWith("structuralMove")));
  };
  return { a, b, noticesA, noticesB, sync, close: () => { a.ydoc.destroy(); b.ydoc.destroy(); } };
}

for (const reload of [false, true]) for (const typistFirst of [false, true]) test(`remote move notices only the typist with a selectable range (reload=${reload}, typistFirst=${typistFirst})`, () => {
  const { a, b, noticesA, noticesB, sync, close } = pair(reload);
  try {
    moveScenes(a, ["b"], null);
    b.insertText("b-text", 2, "RECOVER ", { italic: true });
    sync(typistFirst);
    assert.deepEqual(noticesA, []);
    assert.equal(noticesB.length, 1);
    const conflict = noticesB[0]!;
    assert.deepEqual([conflict.paragraphId, conflict.text, conflict.currentParagraphId, conflict.heading],
      ["b-text", "RECOVER ", "a-text", "INT. B - DAY"]);
    const oldPosition = plainText(b.paragraph("a-text").runs);
    assert.ok(oldPosition.includes("RECOVER "));
    b.insertText("a", 0, "Unrelated ");
    assert.ok(strandedMoveRange(b, conflict), "edits before the notice do not invalidate its identities");
    const range = strandedMoveRange(b, conflict)!;
    assert.equal(b.body.toString().slice(range.start, range.start + range.length), conflict.text);
    assert.equal(structuralMoveScene(b, conflict).headingId, "b");
    assert.equal(plainText(b.paragraph("b-text").runs), "B text.");
  } finally { close(); }
});

test("Return notices retain real paragraph markers and formatted runs", () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    moveScenes(a, ["b"], null);
    b.insertText("b-text", 2, "FIRST", { bold: true });
    const next = b.splitParagraph("b-text", 7, "dialogue");
    b.insertText(next, 0, "SECOND", { italic: true });
    sync();
    assert.equal(noticesB.length, 1);
    assert.equal(noticesB[0]!.text, "FIRST\nSECOND");
    assert.ok(strandedMoveRange(b, noticesB[0]!));
    assert.equal(b.paragraph(next).type, "dialogue");
    assert.ok(noticesB[0]!.delta.some(op => op.insert === "\n" && op.attributes?.type === "dialogue"));
    assert.ok(noticesB[0]!.delta.some(op => op.insert === "FIRST" && op.attributes?.bold));
    assert.ok(noticesB[0]!.delta.some(op => op.insert === "SECOND" && op.attributes?.italic));
  } finally { close(); }
});

test("a single writer moving then typing near the old position produces no notice", () => {
  const { a, b, noticesA, noticesB, sync, close } = pair();
  try {
    moveScenes(a, ["b"], null); a.insertText("a-text", 2, "ORDINARY "); sync();
    assert.deepEqual(noticesA, []); assert.deepEqual(noticesB, []);
    b.insertText("a-text", 3, "MORE "); sync();
    assert.deepEqual(noticesA, []); assert.deepEqual(noticesB, []);
  } finally { close(); }
});

test("remote plain scene deletion while typing produces no move notice", () => {
  const { a, b, noticesA, noticesB, sync, close } = pair();
  try {
    a.ydoc.transact(() => { a.deleteParagraph("b-text"); a.deleteParagraph("b"); });
    b.insertText("b-text", 2, "SURVIVES "); sync();
    assert.ok(b.body.toString().includes("SURVIVES "));
    assert.deepEqual(noticesA, []); assert.deepEqual(noticesB, []);
  } finally { close(); }
});

test("concurrent moves retain both copies with unique repaired IDs and no typing notice", () => {
  const { a, b, noticesA, noticesB, sync, close } = pair();
  try {
    moveScenes(a, ["b"], null); moveScenes(b, ["b"], "a"); sync();
    assert.deepEqual(noticesA, []); assert.deepEqual(noticesB, []);
    const paragraphs = a.paragraphs(), scenes = a.scenes();
    assert.equal(paragraphs.filter(p => plainText(p.runs) === "INT. B - DAY").length, 2);
    assert.equal(new Set(paragraphs.map(p => p.id)).size, paragraphs.length);
    assert.equal(new Set(scenes.map(s => s.sceneId)).size, scenes.length);
  } finally { close(); }
});

test("a remote move of a different scene leaves local typing alone", () => {
  const { a, b, noticesA, noticesB, sync, close } = pair();
  try {
    moveScenes(a, ["c"], "a"); b.insertText("b-text", 2, "STAYS "); sync();
    assert.equal(plainText(b.paragraph("b-text").runs), "B STAYS text.");
    assert.deepEqual(noticesA, []); assert.deepEqual(noticesB, []);
  } finally { close(); }
});

test("a notice becomes unselectable after deletion, replacement, insertion inside, or reformatting", () => {
  for (const change of ["delete", "replace", "insert", "format"]) {
    const { a, b, noticesB, sync, close } = pair();
    try {
      moveScenes(a, ["b"], null); b.insertText("b-text", 2, "STALE"); sync();
      const conflict = noticesB[0]!, range = strandedMoveRange(b, conflict)!;
      if (change === "delete") b.body.delete(range.start, 1);
      if (change === "replace") { b.body.delete(range.start, 1); b.body.insert(range.start, "S"); }
      if (change === "insert") b.body.insert(range.start + 2, "!");
      if (change === "format") b.body.format(range.start, 1, { bold: true });
      assert.equal(strandedMoveRange(b, conflict), undefined, change);
    } finally { close(); }
  }
});

test("moving a section detects typing stranded in a nested scene", () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    moveSection(a, "act", null); b.insertText("b-text", 2, "SECTION "); sync();
    assert.equal(noticesB[0]?.heading, "INT. B - DAY");
    assert.equal(noticesB[0]?.text, "SECTION ");
    assert.ok(strandedMoveRange(b, noticesB[0]!));
  } finally { close(); }
});

test("a stranded Return alone is selectable as a real paragraph marker", () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    moveScenes(a, ["b"], null);
    const next = b.splitParagraph("b-text", 2, "character"); sync();
    assert.equal(noticesB[0]?.text, "\n");
    assert.ok(strandedMoveRange(b, noticesB[0]!));
    assert.equal(b.paragraph(next).type, "character");
    assert.ok(noticesB[0]!.delta.some(op => op.insert === "\n" && op.attributes?.type === "character"));
  } finally { close(); }
});

test("a read-only replica that saw the typist's edits before the move has no local notice", () => {
  const { a, b, noticesA, noticesB, sync, close } = pair();
  const follower = ScreenplayDoc.fromUpdate(a.encodeState());
  follower.setRepairs(false);
  const notices: StructuralMoveConflict[] = [];
  follower.body.observe((_event, transaction) => notices.push(...strandedByMove(follower, transaction)));
  try {
    moveScenes(a, ["b"], null); b.insertText("b-text", 2, "PRIVATE NOTICE ");
    follower.applyUpdate(b.encodeState(), "net");
    const before = [...follower.meta.entries()].filter(([key]) => !key.startsWith("move."));
    follower.applyUpdate(a.encodeState(), "net"); sync();
    assert.equal(noticesB.length, 1); assert.deepEqual(noticesA, []); assert.deepEqual(notices, []);
    assert.deepEqual([...follower.meta.entries()].filter(([key]) => !key.startsWith("move.")), before);
    const key = `move.${a.ydoc.clientID}`;
    assert.deepEqual(follower.meta.get(key), a.meta.get(key));
    assert.deepEqual(follower.toScript(), b.toScript());
  } finally { follower.ydoc.destroy(); close(); }
});
