import assert from "node:assert/strict";
import { test } from "node:test";
import { ScreenplayDoc, moveScenes, plainText, strandedByMove, strandedMoveRange, type StructuralMoveConflict } from "../src/index.ts";

const script = () => ({ titlePage: [], paragraphs: ["a", "b", "c", "d", "e"].flatMap(id => [
  { id, sceneId: id, type: "sceneHeading" as const, runs: [{ text: `INT. ${id} - DAY` }] },
  { id: `${id}t`, type: "action" as const, runs: [{ text: "abcdef" }] },
]) });

function pair() {
  const a = ScreenplayDoc.fromScript(script()), b = ScreenplayDoc.fromUpdate(a.encodeState());
  const noticesA: StructuralMoveConflict[] = [], noticesB: StructuralMoveConflict[] = [];
  a.body.observe((_event, transaction) => noticesA.push(...strandedByMove(a, transaction)));
  b.body.observe((_event, transaction) => noticesB.push(...strandedByMove(b, transaction)));
  const sync = () => {
    a.applyUpdate(b.encodeState(), "net"); b.applyUpdate(a.encodeState(), "net");
    a.applyUpdate(b.encodeState(), "net"); b.applyUpdate(a.encodeState(), "net");
    assert.deepEqual(a.toScript(), b.toScript());
    assert.ok(![...a.meta.keys(), ...b.meta.keys()].some(key => key.startsWith("structuralMove")));
  };
  return { a, b, noticesA, noticesB, sync, close: () => { a.ydoc.destroy(); b.ydoc.destroy(); } };
}

test("disjoint moves never capture the untouched scene between their source blocks", () => {
  const { a, b, noticesA, sync, close } = pair();
  try {
    moveScenes(b, ["b", "d"], null); sync();
    assert.deepEqual(noticesA, []);
    assert.deepEqual(a.scenes().map(scene => scene.sceneId), ["a", "c", "e", "b", "d"]);
    assert.equal(plainText(a.paragraph("ct").runs), "abcdef");
  } finally { close(); }
});

for (const withReturn of [false, true]) for (const scene of ["b", "e"]) test(`scene-end typing is detected and selectable (Return=${withReturn}, scene=${scene})`, () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    moveScenes(a, [scene], scene === "e" ? "a" : null);
    let paragraph = `${scene}t`;
    if (withReturn) paragraph = b.splitParagraph(paragraph, 6, "dialogue");
    b.insertText(paragraph, withReturn ? 0 : 6, "XXX"); sync();
    assert.equal(noticesB.length, 1);
    assert.equal(noticesB[0]!.text, withReturn ? "\nXXX" : "XXX");
    assert.ok(strandedMoveRange(b, noticesB[0]!));
    if (withReturn) assert.equal(b.paragraph(paragraph).type, "dialogue");
  } finally { close(); }
});

test("incoming characters split candidates into immediately selectable ranges", () => {
  const { a, b, noticesB, sync, close } = pair();
  const c = ScreenplayDoc.fromUpdate(a.encodeState());
  try {
    moveScenes(a, ["b"], null); b.insertText("bt", 2, "XY");
    c.applyUpdate(b.encodeState(), "net"); c.insertText("bt", 3, "FOREIGN");
    a.applyUpdate(c.encodeState(), "net"); b.applyUpdate(a.encodeState(), "net");
    assert.equal(noticesB.length, 2);
    assert.deepEqual(noticesB.map(notice => notice.text), ["X", "Y"]);
    for (const notice of noticesB) {
      const range = strandedMoveRange(b, notice)!;
      assert.equal(b.body.toString().slice(range.start, range.start + range.length), notice.text);
    }
    sync();
    assert.equal(plainText(b.paragraph("bt").runs), "abcdef");
    assert.ok(b.body.toString().includes("FOREIGN"));
    assert.ok(!plainText(b.paragraph("bt").runs).includes("FOREIGN"));
  } finally { c.ydoc.destroy(); close(); }
});

test("a remote snapshot replacement with identical paragraph order is not a move", () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    a.load(script()); b.insertText("bt", 2, "XXX"); sync();
    assert.deepEqual(noticesB, []);
    assert.ok(b.body.toString().includes("XXX"));
  } finally { close(); }
});

test("disjoint source blocks report only concurrent edits inside each moved scene", () => {
  const { a, b, noticesA, sync, close } = pair();
  try {
    moveScenes(b, ["b", "d"], null);
    a.insertText("bt", 2, "B EDIT"); a.insertText("dt", 2, "D EDIT"); a.insertText("ct", 2, "C EDIT"); sync();
    assert.deepEqual(noticesA.map(notice => [notice.paragraphId, notice.text]), [["bt", "B EDIT"], ["dt", "D EDIT"]]);
    for (const notice of noticesA) assert.ok(strandedMoveRange(a, notice));
    assert.ok(plainText(a.paragraph("ct").runs).includes("abC EDITcdef"));
  } finally { close(); }
});

for (const change of ["merge", "type"]) test(`existing scene text is not stranded typing after concurrent ${change}`, () => {
  const { a: typist, b: mover, noticesA, sync, close } = pair();
  try {
    moveScenes(mover, ["b"], null);
    if (change === "merge") typist.mergeWithPrevious("c");
    else typist.setType("c", "action");
    sync(); assert.deepEqual(noticesA, []);
  } finally { close(); }
});

for (const type of ["sceneHeading", "section"] as const) test(`newly typed ${type} markers are absent from the mover's vector`, () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    moveScenes(a, ["b"], null);
    const next = b.splitParagraph("bt", 3, type); b.insertText(next, 0, "NEW"); sync();
    assert.equal(noticesB.length, 1);
    assert.equal(noticesB[0]!.text, "\nNEW");
    assert.equal(noticesB[0]!.paragraphId, "bt");
    assert.ok(strandedMoveRange(b, noticesB[0]!));
    assert.equal(b.paragraph(next).type, type);
  } finally { close(); }
});

test("an in-place restoration batched with a move never raises a move notice", () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    const copies = [a.paragraph("b"), a.paragraph("bt")];
    a.ydoc.transact(() => {
      a.deleteParagraph("bt"); a.deleteParagraph("b");
      copies.forEach((paragraph, index) => a.insertParagraph(2 + index, paragraph));
    });
    moveScenes(a, ["c"], "a"); b.insertText("bt", 2, "X"); sync();
    assert.deepEqual(noticesB.map(notice => [notice.paragraphId, notice.text]), []);
  } finally { close(); }
});

for (const type of ["sceneHeading", "section"] as const) test(`an original author typing a ${type} cannot pull following existing scenes into the notice`, () => {
  const { a: typist, b: mover, noticesA, sync, close } = pair();
  try {
    moveScenes(mover, ["b"], "a");
    const next = typist.splitParagraph("bt", 3, type); typist.insertText(next, 0, "NEW"); sync();
    assert.deepEqual(noticesA.map(notice => notice.text), ["\nNEW"]);
    assert.ok(strandedMoveRange(typist, noticesA[0]!));
    assert.ok(typist.has("c")); assert.ok(typist.has("d"));
  } finally { close(); }
});

test("only the moved scene reports typing in a mixed restoration and move batch", () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    const copies = [a.paragraph("b"), a.paragraph("bt")];
    a.ydoc.transact(() => {
      a.deleteParagraph("bt"); a.deleteParagraph("b");
      copies.forEach((paragraph, index) => a.insertParagraph(2 + index, paragraph));
    });
    moveScenes(a, ["c"], "a");
    b.insertText("bt", 2, "RESTORED"); b.insertText("ct", 2, "MOVED"); sync();
    assert.deepEqual(noticesB.map(notice => [notice.paragraphId, notice.text]), [["ct", "MOVED"]]);
  } finally { close(); }
});

test("the original author appending at document end is absent from the move-time vector", () => {
  const { a: typist, b: mover, noticesA, sync, close } = pair();
  try {
    moveScenes(mover, ["e"], "a"); typist.insertText("et", 6, "END"); sync();
    assert.deepEqual(noticesA.map(notice => notice.text), ["END"]);
    assert.ok(strandedMoveRange(typist, noticesA[0]!));
  } finally { close(); }
});

for (const type of ["sceneHeading", "section"] as const) test(`a fully synced ${type} left outside a later move is not stranded typing`, () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    const next = b.splitParagraph("bt", 3, type); b.insertText(next, 0, "NEW"); sync();
    moveScenes(a, ["b"], null); sync();
    assert.deepEqual(noticesB, []);
    assert.equal(b.paragraph(next).type, type);
  } finally { close(); }
});

for (const operation of ["load", "move"]) test(`unrecorded local deletion anchors are not borrowed by a ${operation}`, () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    if (operation === "load") a.load(script()); else moveScenes(a, ["b"], null);
    b.insertText("bt", 2, "X"); b.insertText("bt", 7, "Y");
    const next = b.splitParagraph("bt", 8, "dialogue");
    b.deleteText("bt", 7, 1); b.insertText(next, 0, "NEW"); sync();
    assert.deepEqual(noticesB.map(notice => notice.text), operation === "move" ? ["X"] : []);
    for (const notice of noticesB) assert.ok(strandedMoveRange(b, notice));
  } finally { close(); }
});

test("an unrelated later deletion cannot advance the mover's knowledge of stranded text", () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    moveScenes(a, ["b"], null);
    b.insertText("bt", 2, "X"); b.insertText("ct", 2, "LATER");
    a.applyUpdate(b.encodeState(), "net"); a.deleteText("ct", 2, 5);
    b.applyUpdate(a.encodeState(), "net"); sync();
    assert.deepEqual(noticesB.map(notice => notice.text), ["X"]);
  } finally { close(); }
});

for (const type of ["bold", "dialogue", "sceneHeading", "section"] as const) test(`original-author ${type} typing at document end is detected`, () => {
  const { a: typist, b: mover, noticesA, sync, close } = pair();
  try {
    moveScenes(mover, ["e"], "a");
    if (type === "bold") typist.insertText("et", 6, "X", { bold: true });
    else { const next = typist.splitParagraph("et", 6, type); typist.insertText(next, 0, "NEW"); }
    sync();
    assert.deepEqual(noticesA.map(notice => notice.text), [type === "bold" ? "X" : "\nNEW"]);
    assert.ok(strandedMoveRange(typist, noticesA[0]!));
  } finally { close(); }
});

test("a scene moved across an adjacent restored scene still reports concurrent typing", () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    const copies = [a.paragraph("a"), a.paragraph("at")];
    a.ydoc.transact(() => {
      a.deleteParagraph("at"); a.deleteParagraph("a");
      copies.forEach((paragraph, index) => a.insertParagraph(index, paragraph));
    });
    moveScenes(a, ["b"], "a"); b.insertText("bt", 2, "X"); sync();
    assert.deepEqual(noticesB.map(notice => notice.text), ["X"]);
  } finally { close(); }
});

for (const prefixTiming of ["with move", "after detection"]) test(`destination prefix edits leave review ranges unchanged (${prefixTiming})`, () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    moveScenes(a, ["b"], null); b.insertText("bt", 3, "XXX");
    if (prefixTiming === "with move") a.insertText("bt", 0, "PREFIX");
    sync();
    if (prefixTiming === "after detection") { a.insertText("bt", 0, "PREFIX"); sync(); }
    assert.equal(noticesB.length, 1);
    const range = strandedMoveRange(b, noticesB[0]!)!;
    assert.equal(b.body.toString().slice(range.start, range.start + range.length), "XXX");
    assert.equal(plainText(b.paragraph("bt").runs), "PREFIXabcdef");
  } finally { close(); }
});

test("repeated source text does not affect exact review selection", () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    a.replaceText("bt", 0, 6, "abab"); sync();
    moveScenes(a, ["b"], null); b.insertText("bt", 2, "X"); sync();
    assert.deepEqual(noticesB.map(notice => notice.text), ["X"]);
    const range = strandedMoveRange(b, noticesB[0]!)!;
    assert.equal(b.body.toString().slice(range.start, range.start + range.length), "X");
    assert.equal(plainText(b.paragraph("bt").runs), "abab");
  } finally { close(); }
});

test("separate Return and trailing-text notices each select exactly their surviving characters", () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    moveScenes(a, ["b"], null); b.insertText("bt", 3, "FIRST");
    const next = b.splitParagraph("bt", 8, "dialogue");
    b.insertText(next, 0, "SECOND"); b.insertText(next, 8, "TAIL"); sync();
    assert.deepEqual(noticesB.map(notice => notice.text), ["FIRST\nSECOND", "TAIL"]);
    for (const notice of noticesB) {
      const range = strandedMoveRange(b, notice)!;
      assert.equal(b.body.toString().slice(range.start, range.start + range.length), notice.text);
    }
    assert.equal(plainText(b.paragraph("bt").runs), "abcdef");
  } finally { close(); }
});

for (const type of ["sceneHeading", "section"] as const) test(`an older mover's vector cannot flag a synced ${type} outside another mover's deletion`, () => {
  const { a, b, noticesB, sync, close } = pair();
  const c = ScreenplayDoc.fromUpdate(a.encodeState());
  try {
    const next = b.splitParagraph("bt", 3, type); b.insertText(next, 0, "NEW"); sync();
    moveScenes(a, ["b"], null); moveScenes(c, ["d"], "a");
    a.applyUpdate(c.encodeState(), "net"); b.applyUpdate(a.encodeState(), "net");
    assert.deepEqual(noticesB, []);
    assert.ok(b.has(next));
  } finally { c.ydoc.destroy(); close(); }
});

test("a plain scene deletion batched with another scene's move never raises a move notice", () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    a.ydoc.transact(() => { a.deleteParagraph("bt"); a.deleteParagraph("b"); });
    moveScenes(a, ["c"], "a"); b.insertText("bt", 2, "DELETE"); sync();
    assert.deepEqual(noticesB, []);
    assert.ok(b.body.toString().includes("DELETE"));
  } finally { close(); }
});

test("an unrecorded deleted gap conservatively prevents a notice across its tombstones", () => {
  const { a, b, noticesB, sync, close } = pair();
  try {
    a.insertText("bt", 2, "discard", { bold: true }); a.deleteText("bt", 2, 7); sync();
    moveScenes(a, ["b"], null); b.insertText("bt", 2, "X", { italic: true }); sync();
    assert.deepEqual(noticesB, []);
    assert.ok(b.body.toString().includes("X"));
  } finally { close(); }
});
