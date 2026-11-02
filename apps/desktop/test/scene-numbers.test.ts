// Scene-number collisions after a co-writing merge, and the number lock in FDX.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ScreenplayDoc, assertUniqueSceneNumbers, issuedSceneNumbers, numberAddedScenes, parseFdx, resolveSceneNumberConflicts, sceneNumberConflicts,
  sceneNumberRenumberings, sceneNumbersLocked, setSceneNumbersLocked, writeFdx, type Paragraph,
} from "@screenplay/engine";

import { DocumentSession } from "../src/renderer/core/session.ts";
import { resolveSceneNumbersForDelivery } from "../src/renderer/features/revisions/settle.ts";

const heading = (id: string, number: string, text: string): Paragraph => ({
  id, sceneId: `s-${id}`, type: "sceneHeading", sceneNumber: number, runs: [{ text }],
});

function lockedSession(paragraphs: Paragraph[]): DocumentSession {
  const doc = new ScreenplayDoc();
  doc.load({ titlePage: [], paragraphs });
  setSceneNumbersLocked(doc, true);
  const session = new DocumentSession(doc);
  session.undo.clear();
  return session;
}

const numbersOf = (doc: ScreenplayDoc) => doc.paragraphs()
  .filter((p) => p.type === "sceneHeading").map((p) => `${p.id}:${p.sceneNumber ?? "-"}`);

const settle = async (doc: ScreenplayDoc) => {
  for (let i = 0; i < 200 && sceneNumberConflicts(doc.paragraphs()).length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

test("two sessions adding a scene in the same locked gap keep unique numbers after their updates meet", async () => {
  const a = lockedSession([heading("first", "12", "INT. HALL - DAY"), heading("last", "13", "EXT. ROAD - DAY")]);
  const b = new DocumentSession(ScreenplayDoc.fromUpdate(a.doc.encodeState()));
  b.undo.clear();
  try {
    const one = a.edit(() => a.doc.insertParagraph(1, { type: "sceneHeading", runs: [{ text: "INT. STAIRS - DAY" }] }));
    const two = b.edit(() => b.doc.insertParagraph(1, { type: "sceneHeading", runs: [{ text: "INT. GARAGE - DAY" }] }));
    // Each window numbers its own addition, as Revision tracking does.
    a.edit(() => numberAddedScenes(a.doc));
    b.edit(() => numberAddedScenes(b.doc));

    a.doc.applyUpdate(b.doc.encodeState(), "net");
    b.doc.applyUpdate(a.doc.encodeState(), "net");
    const undoDepth = a.undo.undoStack.length;
    await settle(a.doc);

    assertUniqueSceneNumbers(a.doc.toScript());
    assert.deepEqual(numbersOf(a.doc), numbersOf(b.doc));
    const order = a.doc.paragraphs().filter((p) => p.id === one || p.id === two).map((p) => p.id);
    assert.deepEqual(order.map((id) => a.doc.paragraph(id).sceneNumber), ["12A", "12B"], "in script order: the first scene keeps 12A");
    assert.equal(a.doc.paragraph("first").sceneNumber, "12");
    assert.equal(a.doc.paragraph("last").sceneNumber, "13");
    assert.deepEqual(sceneNumberRenumberings(a.doc), sceneNumberRenumberings(b.doc), "both windows tell the same story");
    assert.equal(sceneNumberRenumberings(a.doc).length, 1);
    assert.equal(a.undo.undoStack.length, undoDepth, "the renumbering is not an edit Undo takes back");
  } finally {
    a.destroy(); b.destroy();
  }
});

test("delivery settles a duplicate in a locked file", () => {
  const doc = new ScreenplayDoc();
  doc.load({ titlePage: [], paragraphs: [
    heading("a", "1", "INT. ONE - DAY"), heading("b", "1", "INT. ONE AGAIN - DAY"), heading("c", "2", "EXT. ROAD - DAY"),
  ] });
  setSceneNumbersLocked(doc, true);
  const session = new DocumentSession(doc);
  try {
    assert.throws(() => assertUniqueSceneNumbers(session.script()), /Duplicate scene numbers/);
    assert.equal(resolveSceneNumbersForDelivery(session), true);
    assert.equal(sceneNumberConflicts(doc.paragraphs()).length, 0);
    assert.deepEqual(numbersOf(doc), ["a:1", "b:1A", "c:2"]);
    assertUniqueSceneNumbers(session.script());
    assert.equal(resolveSceneNumbersForDelivery(session), false, "nothing left to change");
  } finally {
    session.destroy();
  }
});

test("delivery leaves an unlocked imported collision unchanged and blocked for explicit review", () => {
  const doc = ScreenplayDoc.fromScript(parseFdx(`<FinalDraft DocumentType="Script" Version="5"><Content>
    <Paragraph Type="Scene Heading" id="a" Number="12A"><Text>INT. HALL - DAY</Text></Paragraph>
    <Paragraph Type="Scene Heading" id="b" Number="12A"><Text>INT. STAIRS - DAY</Text></Paragraph>
    <Paragraph Type="Scene Heading" id="c" Number="13"><Text>EXT. ROAD - DAY</Text></Paragraph>
  </Content></FinalDraft>`));
  const session = new DocumentSession(doc);
  try {
    const before = doc.encodeState();
    assert.equal(resolveSceneNumbersForDelivery(session), false);
    assert.equal(sceneNumbersLocked(doc), false);
    assert.deepEqual(doc.encodeState(), before);
    assert.equal(session.dirty, false);
    assert.equal(session.undo.undoStack.length, 0);
    assert.equal(sceneNumberConflicts(doc.paragraphs()).length, 1);
    assert.throws(() => assertUniqueSceneNumbers(session.script()), /Review Production > Scene Number Conflicts/);
  } finally { session.destroy(); }
});

test("a locked session repairs an unnumbered remote heading even without duplicates", async () => {
  const session = lockedSession([
    heading("first", "12", "INT. HALL - DAY"), heading("added", "12A", "INT. STAIRS - DAY"), heading("last", "13", "EXT. ROAD - DAY"),
  ]);
  try {
    session.doc.ydoc.transact(() => session.doc.setField("added", "sceneNumber", undefined), "net");
    assert.deepEqual(sceneNumberConflicts(session.doc.paragraphs()), []);
    for (let i = 0; i < 200 && session.doc.paragraph("added").sceneNumber === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(session.doc.paragraph("added").sceneNumber, "12A");
    assert.equal(session.undo.undoStack.length, 0);
  } finally { session.destroy(); }
});

test("delivery detects repairs to missing numbers and read-only sessions leave them to writers", () => {
  const session = lockedSession([
    heading("first", "12", "INT. HALL - DAY"),
    { id: "added", type: "sceneHeading", runs: [{ text: "INT. STAIRS - DAY" }] },
    heading("last", "13", "EXT. ROAD - DAY"),
  ]);
  try {
    session.setReadOnly(true);
    assert.equal(resolveSceneNumbersForDelivery(session), false);
    assert.equal(session.doc.paragraph("added").sceneNumber, undefined);
    session.setReadOnly(false);
    assert.equal(resolveSceneNumbersForDelivery(session), true);
    assert.equal(session.doc.paragraph("added").sceneNumber, "12A");
    assert.equal(resolveSceneNumbersForDelivery(session), false);
  } finally { session.destroy(); }
});

test("the scene number lock survives writing and reopening an FDX, and says which numbers it issued", () => {
  const doc = new ScreenplayDoc();
  doc.load({ titlePage: [], paragraphs: [heading("h1", "1", "INT. ROOM - DAY"), heading("h2", "2", "EXT. ROAD - DAY")] });
  try {
    assert.equal(sceneNumbersLocked(doc), false);
    setSceneNumbersLocked(doc, true);
    const xml = writeFdx(doc.toScript());
    const reopened = ScreenplayDoc.fromScript(parseFdx(xml));
    assert.equal(sceneNumbersLocked(reopened), true);
    assert.deepEqual([...issuedSceneNumbers(reopened)], [["h1", "1"], ["h2", "2"]]);

    // Two scenes added in the same gap after reopening share 3; the later one moves, the issued numbers stay.
    reopened.insertParagraph(1, { type: "sceneHeading", sceneNumber: "3", runs: [{ text: "INT. ATTIC - DAY" }] });
    reopened.insertParagraph(2, { type: "sceneHeading", sceneNumber: "3", runs: [{ text: "INT. CELLAR - DAY" }] });
    const { renumbered, conflicts } = resolveSceneNumberConflicts(reopened);
    assert.deepEqual(conflicts, []);
    assert.deepEqual(renumbered.map((change) => change.to), ["3A"]);
    assert.deepEqual(reopened.paragraphs().filter((p) => p.type === "sceneHeading").map((p) => p.sceneNumber), ["1", "3", "3A", "2"]);
    assert.equal(reopened.paragraph("h1").sceneNumber, "1");
    assert.equal(reopened.paragraph("h2").sceneNumber, "2");
    reopened.ydoc.destroy();
  } finally {
    doc.ydoc.destroy();
  }
});
