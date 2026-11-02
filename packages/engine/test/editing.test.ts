// Editing operations the script editor relies on: deleting across paragraphs, pasting paragraphs,
// caret mapping, and the paragraph cache staying identical to a fresh read of the Y.Text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as Y from "yjs";

import { ScreenplayDoc, parseFdx, parseFountain, plainText, type ElementType, type Paragraph } from "../src/index.ts";

const rows = (doc: ScreenplayDoc) => doc.toScript().paragraphs.map((p) => [p.type, plainText(p.runs)]);
const ids = (doc: ScreenplayDoc) => doc.toScript().paragraphs.map((p) => p.id);

/** A second document reading the same updates, so its cache is built from scratch. */
function freshRead(doc: ScreenplayDoc): Paragraph[] {
  return ScreenplayDoc.fromUpdate(doc.encodeState()).toScript().paragraphs;
}

const SCENE = "INT. KITCHEN - NIGHT\n\nMara opens the fridge.\n\nMARA\nNothing.\n\nShe closes it.\n";

test("deleteRange inside one paragraph deletes only those characters", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SCENE));
  const action = ids(doc)[1]!;
  doc.deleteRange({ paragraphId: action, offset: 5 }, { paragraphId: action, offset: 11 });
  assert.equal(plainText(doc.paragraph(action).runs), "Mara the fridge.");
  // Reversed ends are fine.
  doc.deleteRange({ paragraphId: action, offset: 9 }, { paragraphId: action, offset: 5 });
  assert.equal(plainText(doc.paragraph(action).runs), "Mara fridge.");
});

test("deleteRange across paragraphs keeps the first paragraph's ID and type", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SCENE));
  const [heading, action, cue, line, last] = ids(doc);
  doc.deleteRange({ paragraphId: action!, offset: 4 }, { paragraphId: line!, offset: 7 });
  assert.deepEqual(rows(doc), [["sceneHeading", "INT. KITCHEN - NIGHT"], ["action", "Mara."], ["action", "She closes it."]]);
  assert.deepEqual(ids(doc), [heading, action, last]);
  assert.ok(!doc.has(cue!));
  assert.deepEqual(doc.validate(), []);
});

test("deleteRange keeps a co-writer's typing on both sides of the range", () => {
  const a = ScreenplayDoc.fromScript(parseFountain(SCENE));
  const b = ScreenplayDoc.fromUpdate(a.encodeState());
  const [, action, , line, last] = ids(a);
  a.deleteRange({ paragraphId: action!, offset: 4 }, { paragraphId: line!, offset: 7 });
  b.insertText(last!, 0, "Then ");
  b.insertText(action!, 0, "Tired, ");
  a.applyUpdate(b.encodeState());
  b.applyUpdate(a.encodeState());
  assert.deepEqual(rows(a), rows(b));
  assert.deepEqual(rows(a).map(([, text]) => text), ["INT. KITCHEN - NIGHT", "Tired, Mara.", "Then She closes it."]);
  assert.deepEqual(a.validate(), []);
});

test("deleteRange keeps text a co-writer typed inside the deleted range", () => {
  const a = ScreenplayDoc.fromScript(parseFountain(SCENE));
  const b = ScreenplayDoc.fromUpdate(a.encodeState());
  const [, action, cue, line] = ids(a);
  a.deleteRange({ paragraphId: action!, offset: 4 }, { paragraphId: line!, offset: 7 });
  b.insertText(cue!, 4, " (V.O.)");
  a.applyUpdate(b.encodeState());
  b.applyUpdate(a.encodeState());
  assert.deepEqual(rows(a), rows(b));
  assert.match(plainText(a.paragraph(action!).runs), /\(V\.O\.\)/);
});

const PASTE: Paragraph[] = [
  { id: "p1", type: "character", runs: [{ text: "JONAH" }] },
  { id: "p2", type: "dialogue", runs: [{ text: "Is it ", bold: true }, { text: "on?" }] },
];

test("insertParagraphsAt splits a paragraph and puts the paste between the halves", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SCENE));
  const action = ids(doc)[1]!;
  const inserted = doc.insertParagraphsAt({ paragraphId: action, offset: 5 }, PASTE);
  assert.equal(inserted.length, 2);
  assert.deepEqual(rows(doc).slice(1, 5), [["action", "Mara "], ["character", "JONAH"], ["dialogue", "Is it on?"], ["action", "opens the fridge."]]);
  assert.deepEqual(doc.paragraph(inserted[1]!).runs, PASTE[1]!.runs);
  assert.ok(!inserted.includes("p1") && !inserted.includes("p2"), "pasted paragraphs get new IDs");
  // Pasting the same paragraphs again never repeats an ID.
  doc.insertParagraphsAt({ paragraphId: action, offset: 0 }, PASTE);
  assert.deepEqual(doc.validate(), []);
  assert.equal(doc.toScript().paragraphs.length, 10);
});

test("insertParagraphsAt at the start, at the end, and into an empty paragraph", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SCENE));
  const [heading, action] = ids(doc);
  doc.insertParagraphsAt({ paragraphId: action!, offset: 0 }, PASTE);
  assert.deepEqual(rows(doc).slice(1, 4).map(([type]) => type), ["character", "dialogue", "action"]);
  doc.insertParagraphsAt({ paragraphId: heading!, offset: "INT. KITCHEN - NIGHT".length }, [{ id: "x", type: "action", runs: [{ text: "Dark." }] }]);
  assert.deepEqual(rows(doc)[1], ["action", "Dark."]);

  const empty = doc.splitParagraph(heading!, "INT. KITCHEN - NIGHT".length, "action");
  const result = doc.insertParagraphsAt({ paragraphId: empty, offset: 0 }, [{ id: "h", type: "sceneHeading", runs: [{ text: "EXT. ROOF - DAY" }], sceneNumber: "4" }, ...PASTE]);
  assert.equal(result[0], empty, "the empty paragraph keeps its ID");
  const heading2 = doc.paragraph(empty);
  assert.equal(heading2.type, "sceneHeading");
  assert.equal(heading2.sceneId, empty);
  assert.equal(heading2.sceneNumber, undefined);
  assert.deepEqual(rows(doc).slice(1, 4), [["sceneHeading", "EXT. ROOF - DAY"], ["character", "JONAH"], ["dialogue", "Is it on?"]]);
  assert.deepEqual(doc.validate(), []);
});

test("pasted dual dialogue gets a new block ID", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SCENE));
  const last = ids(doc).at(-1)!;
  const dual: Paragraph[] = [
    { id: "a", type: "character", runs: [{ text: "A" }], dual: { block: "b1", side: 1 } },
    { id: "b", type: "character", runs: [{ text: "B" }], dual: { block: "b1", side: 2 } },
  ];
  const [first, second] = doc.insertParagraphsAt({ paragraphId: last, offset: "She closes it.".length }, dual);
  const block = doc.paragraph(first!).dual!.block;
  assert.notEqual(block, "b1");
  assert.deepEqual(doc.paragraph(second!).dual, { block, side: 2 });
});

test("bodyIndex and positionAt are inverses, and line breaks read as the end of the paragraph before", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SCENE));
  for (const paragraph of doc.toScript().paragraphs) {
    for (const offset of [0, plainText(paragraph.runs).length]) {
      const index = doc.bodyIndex({ paragraphId: paragraph.id, offset });
      assert.deepEqual(doc.positionAt(index), { paragraphId: paragraph.id, offset });
    }
  }
  const [heading, action] = ids(doc);
  assert.deepEqual(doc.positionAt(doc.range(action!).start - 1), { paragraphId: heading!, offset: "INT. KITCHEN - NIGHT".length });
  assert.deepEqual(doc.positionAt(0), { paragraphId: heading!, offset: 0 });
});

test("a relative position follows a co-writer's edits", () => {
  const a = ScreenplayDoc.fromScript(parseFountain(SCENE));
  const b = ScreenplayDoc.fromUpdate(a.encodeState());
  const action = ids(a)[1]!;
  const caret = Y.createRelativePositionFromTypeIndex(a.body, a.bodyIndex({ paragraphId: action, offset: 5 }));
  b.insertText(action, 0, "Slowly, ");
  b.splitParagraph(ids(b)[0]!, 4);
  a.applyUpdate(b.encodeState());
  const absolute = Y.createAbsolutePositionFromRelativePosition(caret, a.ydoc)!;
  assert.deepEqual(a.positionAt(absolute.index), { paragraphId: action, offset: 13 });
});

test("paragraphs() keeps unchanged paragraphs as the same objects", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SCENE));
  const before = doc.paragraphs();
  const action = before[1]!.id;
  doc.insertText(action, 0, "Now ");
  const after = doc.paragraphs();
  assert.notEqual(after[1], before[1]);
  assert.ok(after.every((p, i) => i === 1 || p === before[i]));
  // A remote change rebuilds the list but still reuses unchanged paragraphs.
  const peer = ScreenplayDoc.fromUpdate(doc.encodeState());
  peer.insertText(after[3]!.id, 0, "Not ");
  doc.applyUpdate(peer.encodeState());
  const remote = doc.paragraphs();
  assert.ok(remote.every((p, i) => i === 3 || p === after[i]));
  assert.equal(plainText(remote[3]!.runs), "Not Nothing.");
});

test("paragraph() and toScript() return copies that cannot corrupt the cache", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SCENE));
  const id = ids(doc)[1]!;
  doc.paragraph(id).runs[0]!.text = "changed";
  doc.toScript().paragraphs[1]!.type = "shot";
  assert.deepEqual(rows(doc)[1], ["action", "Mara opens the fridge."]);
});

test("undoing formatting, a field or a type shows in paragraphs()", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(SCENE));
  const undo = new Y.UndoManager([doc.body], { captureTimeout: 0 });
  const [heading, action, cue, line] = ids(doc);
  doc.paragraphs();
  // Undoing Bold on plain text only deletes formatting: neither the clock nor the length moves.
  doc.format(action!, 0, 4, { bold: true });
  assert.equal(doc.paragraphs()[1]!.runs[0]!.bold, true);
  undo.undo();
  assert.deepEqual(doc.paragraphs()[1]!.runs, [{ text: "Mara opens the fridge." }]);
  undo.redo();
  assert.equal(doc.paragraphs()[1]!.runs[0]!.bold, true);
  doc.setField(heading!, "sceneNumber", "12");
  undo.undo();
  assert.equal(doc.paragraphs()[0]!.sceneNumber, undefined);
  doc.setField(cue!, "dual", { block: "b", side: 1 });
  doc.setField(line!, "dual", { block: "b", side: 1 });
  undo.undo();
  undo.undo();
  assert.ok(doc.paragraphs().every((p) => !p.dual));
  doc.setType(action!, "shot");
  undo.undo();
  assert.equal(doc.paragraphs()[1]!.type, "action");
  assert.deepEqual(doc.toScript().paragraphs, freshRead(doc));
});

test("a co-writer clearing formatting or a field shows in paragraphs()", () => {
  const a = ScreenplayDoc.fromScript(parseFountain(SCENE));
  const b = ScreenplayDoc.fromUpdate(a.encodeState());
  const [heading, action] = ids(a);
  b.format(action!, 0, 4, { italic: true });
  b.setField(heading!, "sceneNumber", "3");
  a.applyUpdate(b.encodeState());
  assert.equal(a.paragraphs()[1]!.runs[0]!.italic, true);
  assert.equal(a.paragraphs()[0]!.sceneNumber, "3");
  // Undone on b, the update a receives only deletes formatting.
  const undo = new Y.UndoManager([b.body], { captureTimeout: 0 });
  b.setField(heading!, "sceneNumber", undefined);
  b.format(action!, 0, 4, { italic: false });
  a.applyUpdate(Y.encodeStateAsUpdate(b.ydoc, Y.encodeStateVector(a.ydoc)));
  assert.equal(a.paragraphs()[0]!.sceneNumber, undefined);
  assert.equal(a.paragraphs()[1]!.runs[0]!.italic, undefined);
  undo.undo();
  undo.undo();
  a.applyUpdate(Y.encodeStateAsUpdate(b.ydoc, Y.encodeStateVector(a.ydoc)));
  assert.deepEqual(a.toScript().paragraphs, freshRead(a));
  assert.equal(a.paragraphs()[0]!.sceneNumber, "3");
});

const FDX = readFileSync(new URL("./fixtures/synthetic.fdx", import.meta.url), "utf8");

for (const [name, open] of [["Fountain", () => parseFountain(SCENE)], ["FDX", () => parseFdx(FDX)]] as const) {
  test(`the cache matches a fresh read after random edits, undo, and remote edits (${name})`, () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const types: ElementType[] = ["action", "character", "dialogue", "sceneHeading", "parenthetical"];
    const doc = ScreenplayDoc.fromScript(open());
    const peer = ScreenplayDoc.fromUpdate(doc.encodeState());
    const undo = new Y.UndoManager([doc.body], { captureTimeout: 0 });
    // Undo runs on its own, as a writer's Cmd+Z does, never inside another edit's transaction.
    const edit = (target: ScreenplayDoc, canUndo = false) => {
      const list = target.paragraphs();
      const paragraph = list[random(list.length)]!;
      const length = plainText(paragraph.runs).length;
      const offset = random(length + 1);
      switch (random(11)) {
        case 0: target.insertText(paragraph.id, offset, random(4) ? "ab" : "x\ny", random(3) ? {} : { bold: true }); break;
        case 1: target.deleteText(paragraph.id, offset, random(4)); break;
        case 2: target.format(paragraph.id, offset, random(5), { italic: random(2) === 0, underline: true }); break;
        case 3: target.setType(paragraph.id, types[random(types.length)]!); break;
        case 4: target.setField(paragraph.id, "sceneNumber", random(2) ? String(random(40)) : undefined); break;
        case 5: if (list.length < 30) target.splitParagraph(paragraph.id, offset, types[random(types.length)]); break;
        case 6: if (list.length > 3) target.mergeWithPrevious(paragraph.id); break;
        case 7: {
          const other = list[random(list.length)]!;
          if (list.length > 3) target.deleteRange({ paragraphId: paragraph.id, offset }, { paragraphId: other.id, offset: random(plainText(other.runs).length + 1) });
          break;
        }
        case 8: if (list.length < 30) target.insertParagraphsAt({ paragraphId: paragraph.id, offset }, PASTE); break;
        case 9: if (canUndo) undo.undo(); break;
        case 10: if (canUndo) undo.redo(); break;
      }
    };
    for (let round = 0; round < 400; round++) {
      if (random(3) === 0) doc.ydoc.transact(() => (edit(doc), edit(doc)));
      else edit(doc, true);
      if (random(4) === 0) {
        edit(peer);
        doc.applyUpdate(Y.encodeStateAsUpdate(peer.ydoc, Y.encodeStateVector(doc.ydoc)));
        peer.applyUpdate(Y.encodeStateAsUpdate(doc.ydoc, Y.encodeStateVector(peer.ydoc)));
      }
      assert.deepEqual(doc.toScript().paragraphs, freshRead(doc), `round ${round}`);
    }
  });
}
