import assert from "node:assert/strict";
import { test } from "node:test";
import { ScreenplayDoc, moveScenes, moveSection, plainText, strandedMoveRange, structuralMoveScene } from "@screenplay/engine";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { decodeNative, encodeNative } from "../src/renderer/core/fileformat.ts";
import { nativeOnlyFeatures } from "../src/renderer/features/file/preflight.ts";

function pair() {
  const a = new DocumentSession(ScreenplayDoc.fromScript({ titlePage: [], paragraphs: ["a", "b", "c"].flatMap(id => [
    { id, sceneId: id, type: "sceneHeading" as const, runs: [{ text: `INT. ${id.toUpperCase()} - DAY` }] },
    { id: `${id}-text`, type: "action" as const, runs: [{ text: `${id} text` }] },
  ]) }));
  const b = new DocumentSession(ScreenplayDoc.fromUpdate(a.doc.encodeState()));
  const sync = () => {
    a.doc.applyUpdate(b.doc.encodeState(), "net"); b.doc.applyUpdate(a.doc.encodeState(), "net");
    a.doc.applyUpdate(b.doc.encodeState(), "net"); b.doc.applyUpdate(a.doc.encodeState(), "net");
    assert.deepEqual(a.script(), b.script());
  };
  const strand = () => {
    a.edit(() => moveScenes(a.doc, ["b"], null));
    b.edit(() => b.doc.insertText("b-text", 2, "RECOVER ")); sync();
    assert.equal(a.moveConflicts.length, 0);
    assert.equal(b.moveConflicts.length, 1);
    return b.moveConflicts[0]!;
  };
  return { a, b, sync, strand, close: () => { for (const s of [a, b]) { s.destroy(); s.doc.ydoc.destroy(); } } };
}

test("only the typist's running session holds a notice; native saves and followers do not", () => {
  const { a, b, strand, close } = pair();
  try {
    const follower = new DocumentSession(ScreenplayDoc.fromUpdate(a.doc.encodeState()));
    const conflict = strand();
    assert.equal(conflict.text, "RECOVER ");
    assert.equal(a.undo.undoStack.length, 1);
    assert.equal(b.undo.undoStack.length, 1);
    assert.ok(!nativeOnlyFeatures(b.doc).includes("Scene-move recovery notices"));
    const reopened = new DocumentSession(decodeNative(encodeNative(b.doc, "Draft")).doc);
    try {
      follower.setReadOnly(true);
      follower.doc.applyUpdate(b.doc.encodeState(), "net");
      assert.deepEqual(follower.moveConflicts, []);
      assert.equal(follower.undo.undoStack.length, 0);
      assert.deepEqual(reopened.moveConflicts, []);
      assert.ok(reopened.doc.body.toString().includes("RECOVER "));
      assert.deepEqual(reopened.script(), b.script());
    } finally { for (const s of [reopened, follower]) { s.destroy(); s.doc.ydoc.destroy(); } }
  } finally { close(); }
});

test("Leave it here changes only session memory, and Undo/Redo cannot resurrect the notice", () => {
  const { a, b, sync, strand, close } = pair();
  try {
    const conflict = strand(), before = b.doc.encodeState(), undoCount = b.undo.undoStack.length;
    let notifications = 0;
    b.onState(() => notifications++);
    b.leaveMoveText(conflict.id);
    assert.equal(notifications, 1);
    assert.deepEqual(b.doc.encodeState(), before);
    assert.equal(b.undo.undoStack.length, undoCount);
    assert.deepEqual(b.moveConflicts, []);
    b.undo.undo(); sync(); b.undo.redo(); sync();
    assert.deepEqual(b.moveConflicts, []);
    assert.deepEqual(a.moveConflicts, []);
    assert.ok(b.doc.body.toString().includes("RECOVER "));
    assert.equal(b.moveTextSelection(conflict), undefined);
  } finally { close(); }
});

test("notices disappear when their characters are edited, deleted, or formatted, including remote edits", () => {
  for (const action of ["edit", "delete", "format", "remote"]) {
    const { a, b, sync, strand, close } = pair();
    try {
      const conflict = strand(), range = strandedMoveRange(b.doc, conflict)!;
      if (action === "remote") { a.edit(() => a.doc.body.delete(range.start, 1)); sync(); }
      else b.edit(() => {
        if (action === "edit") b.doc.body.insert(range.start + 2, "!");
        if (action === "delete") b.doc.body.delete(range.start, range.length);
        if (action === "format") b.doc.body.format(range.start, 1, { bold: true });
      });
      assert.deepEqual(b.moveConflicts, [], action);
      b.undo.undo(); sync();
      assert.deepEqual(b.moveConflicts, [], action);
    } finally { close(); }
  }
});

test("a removed source scene disables Show the scene without discarding the stranded text", () => {
  const { a, b, sync, strand, close } = pair();
  try {
    const conflict = strand();
    a.edit(() => { a.doc.deleteParagraph("b-text"); a.doc.deleteParagraph("b"); }); sync();
    assert.equal(b.moveConflicts.length, 1);
    assert.match(structuralMoveScene(b.doc, conflict).reason!, /no longer exists/);
    assert.ok(b.moveTextSelection(conflict));
    assert.ok(b.doc.body.toString().includes("RECOVER "));
    b.leaveMoveText(conflict.id); assert.deepEqual(b.moveConflicts, []);
  } finally { close(); }
});

test("single-writer moves, plain deletes, concurrent moves, and different-scene moves produce no session notices", () => {
  for (const action of ["single", "delete", "both", "different"]) {
    const { a, b, sync, close } = pair();
    try {
      a.edit(() => {
        if (action === "delete") { a.doc.deleteParagraph("b-text"); a.doc.deleteParagraph("b"); }
        else moveScenes(a.doc, [action === "different" ? "c" : "b"], action === "different" ? "a" : null);
        if (action === "single") a.doc.insertText("a-text", 2, "ORDINARY ");
      });
      b.edit(() => {
        if (action === "both") moveScenes(b.doc, ["b"], "a");
        else if (action !== "single") b.doc.insertText("b-text", 2, "TYPING ");
      });
      sync();
      assert.deepEqual(a.moveConflicts, [], action); assert.deepEqual(b.moveConflicts, [], action);
    } finally { close(); }
  }
});

test("remote Undo heals stranded typing and retires the notice and its selection", () => {
  const { a, b, sync, strand, close } = pair();
  try {
    const conflict = strand();
    a.undo.undo(); sync();
    assert.equal(plainText(b.doc.paragraph("b-text").runs), "b RECOVER text");
    assert.deepEqual(b.moveConflicts, []);
    assert.equal(b.moveTextSelection(conflict), undefined);
  } finally { close(); }
});

test("100 pending notices do not rescan or snapshot a 3000-paragraph section on unrelated typing", () => {
  const paragraphs = [
    { id: "act", type: "section" as const, depth: 1, runs: [{ text: "ACT ONE" }] },
    ...Array.from({ length: 3000 }, (_, i) => ({ id: `p${i}`, type: "action" as const, runs: [{ text: "a".repeat(70) }] })),
    { id: "other", type: "section" as const, depth: 1, runs: [{ text: "ACT TWO" }] },
    { id: "unrelated", type: "action" as const, runs: [{ text: "unrelated" }] },
  ];
  const a = new DocumentSession(ScreenplayDoc.fromScript({ titlePage: [], paragraphs }));
  const b = new DocumentSession(ScreenplayDoc.fromUpdate(a.doc.encodeState()));
  try {
    a.edit(() => moveSection(a.doc, "act", null));
    b.edit(() => { for (let i = 0; i < 100; i++) b.doc.insertText(`p${i * 20}`, 2, "X"); });
    b.doc.applyUpdate(a.doc.encodeState(), "net");
    assert.equal(b.moveConflicts.length, 100);
    const body = b.doc.body, toDelta = body.toDelta.bind(body);
    let snapshots = 0, walks = 0, first = body._start;
    Object.defineProperty(body, "_start", { configurable: true, get: () => { walks++; return first; }, set: value => { first = value; } });
    body.toDelta = (...args: Parameters<typeof body.toDelta>) => { snapshots++; return toDelta(...args); };
    const pending = b.moveConflicts;
    for (let i = 0; i < 10; i++) b.edit(() => b.doc.insertText("unrelated", 1, "!"));
    assert.strictEqual(b.moveConflicts, pending, "unrelated changes skip notice validation");
    assert.equal(snapshots, 0, "unrelated keystrokes do not snapshot the body");
    assert.ok(walks <= 20, `unrelated keystrokes started ${walks} body traversals`);
    assert.equal(b.moveConflicts.length, 100);
    const range = strandedMoveRange(b.doc, b.moveConflicts[50]!)!;
    snapshots = 0; walks = 0;
    b.edit(() => body.format(range.start, range.length, { bold: true }));
    assert.ok(snapshots <= 1, `one relevant change took ${snapshots} snapshots`);
    assert.ok(walks <= 3, `one relevant change started ${walks} body traversals`);
    assert.equal(b.moveConflicts.length, 99);
  } finally { for (const s of [a, b]) { s.destroy(); s.doc.ydoc.destroy(); } }
});

test("formatting that surrounds a notice still invalidates it when both format boundaries lie outside", () => {
  const { b, strand, close } = pair();
  try {
    const conflict = strand(), range = strandedMoveRange(b.doc, conflict)!;
    b.edit(() => b.doc.body.insert(range.start + range.length, "TAIL", {}));
    assert.equal(b.moveConflicts.length, 1);
    const text = plainText(b.doc.paragraph("a-text").runs);
    b.edit(() => b.doc.format("a-text", 2, text.length - 2, { bold: true }));
    assert.deepEqual(b.moveConflicts, []);
  } finally { close(); }
});

for (const withReturn of [false, true]) test(`Show where it is now selects the exact text without editing (Return=${withReturn})`, () => {
  const { a, b, sync, close } = pair();
  try {
    a.edit(() => moveScenes(a.doc, ["b"], null));
    b.edit(() => {
      b.doc.insertText("b-text", 2, "FIRST", { bold: true });
      if (withReturn) {
        const next = b.doc.splitParagraph("b-text", 7, "dialogue");
        b.doc.insertText(next, 0, "SECOND", { italic: true });
      }
    });
    sync();
    const conflict = b.moveConflicts[0]!, before = b.doc.encodeState(), undoCount = b.undo.undoStack.length;
    const selection = b.moveTextSelection(conflict)!, range = strandedMoveRange(b.doc, conflict)!;
    assert.equal(b.doc.bodyIndex(selection.anchor), range.start);
    assert.equal(b.doc.bodyIndex(selection.head), range.start + range.length);
    assert.equal(b.doc.body.toString().slice(range.start, range.start + range.length), withReturn ? "FIRST\nSECOND" : "FIRST");
    assert.deepEqual(b.doc.encodeState(), before);
    assert.equal(b.undo.undoStack.length, undoCount);
    assert.deepEqual(structuralMoveScene(b.doc, conflict), { headingId: "b" });
    b.undo.stopCapturing();
    b.edit(() => b.doc.deleteRange(selection.anchor, selection.head));
    assert.deepEqual(b.moveConflicts, []);
    b.undo.undo(); sync();
    assert.deepEqual(b.moveConflicts, []);
    assert.ok(b.doc.body.toString().includes(conflict.text));
  } finally { close(); }
});

test("move knowledge syncs and survives native saves without exchange-preflight warnings", () => {
  const { a, b, sync, close } = pair();
  try {
    const before = nativeOnlyFeatures(a.doc);
    a.edit(() => moveScenes(a.doc, ["b"], null)); sync();
    const key = `move.${a.doc.ydoc.clientID}`, record = a.doc.meta.get(key);
    assert.ok(record); assert.deepEqual(b.doc.meta.get(key), record);
    assert.deepEqual(nativeOnlyFeatures(a.doc), before);
    const reopened = new DocumentSession(decodeNative(encodeNative(a.doc, "Draft")).doc);
    try {
      assert.deepEqual(reopened.doc.meta.get(key), record);
      assert.deepEqual(reopened.moveConflicts, []);
      assert.deepEqual(nativeOnlyFeatures(reopened.doc), before);
    } finally { reopened.destroy(); reopened.doc.ydoc.destroy(); }
  } finally { close(); }
});

test("mover Undo/Redo does not resurrect dismissed notices, and a fresh move still detects new typing", () => {
  const { a, b, sync, strand, close } = pair();
  try {
    b.leaveMoveText(strand().id);
    a.undo.undo(); sync(); a.undo.redo(); sync();
    assert.equal(b.moveConflicts.length, 0);
    assert.ok(b.doc.body.toString().includes("RECOVER "));
    a.undo.stopCapturing();
    a.edit(() => moveScenes(a.doc, ["b"], "a"));
    b.edit(() => b.doc.insertText("b-text", 2, "FRESH ")); sync();
    assert.deepEqual(b.moveConflicts.map(notice => notice.text), ["FRESH "]);
  } finally { close(); }
});

for (const type of ["plain", "bold", "dialogue", "sceneHeading"] as const) test(`a move record arriving apart from its move raises no notice for ${type} typing`, () => {
  const { a, b, close } = pair();
  const set = a.doc.meta.set.bind(a.doc.meta);
  let delayed!: [string, unknown];
  try {
    a.doc.meta.set = (key, value) => {
      if (key.startsWith("move.")) { delayed = [key, value]; return value; }
      return set(key, value);
    };
    a.edit(() => moveScenes(a.doc, ["b"], null));
    a.doc.meta.set = set;
    b.edit(() => {
      if (type === "plain") b.doc.insertText("b-text", 2, "LATE");
      else if (type === "bold") b.doc.insertText("b-text", 6, "LATE", { bold: true });
      else { const next = b.doc.splitParagraph("b-text", 6, type); b.doc.insertText(next, 0, "LATE"); }
    });
    b.doc.applyUpdate(a.doc.encodeState(), "net");
    a.doc.ydoc.transact(() => set(...delayed));
    b.doc.applyUpdate(a.doc.encodeState(), "net");
    // moveRanges never splits a record from its move; one that arrives apart is skipped rather than guessed at.
    assert.deepEqual(b.moveConflicts, []);
  } finally { a.doc.meta.set = set; close(); }
});

for (const operation of ["undo", "redo"] as const) test(`concurrent typing stranded by mover ${operation} deliberately gets no notice`, () => {
  const { a, b, sync, close } = pair();
  try {
    a.edit(() => moveScenes(a.doc, ["b"], null)); sync();
    if (operation === "redo") { a.undo.undo(); sync(); }
    if (operation === "undo") a.undo.undo(); else a.undo.redo();
    b.edit(() => b.doc.insertText("b-text", 2, "UNRECORDED")); sync();
    assert.equal(b.moveConflicts.length, 0);
    assert.ok(b.doc.body.toString().includes("UNRECORDED"));
    assert.ok(!plainText(b.doc.paragraph("b-text").runs).includes("UNRECORDED"));
  } finally { close(); }
});
