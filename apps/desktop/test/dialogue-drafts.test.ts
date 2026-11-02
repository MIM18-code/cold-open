import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { ScreenplayDoc } from "@screenplay/engine";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { nativeOnlyFeatures } from "../src/renderer/features/file/preflight.ts";
import { dialogueDraft, dialogueDraftRecords, saveDialogueDraft } from "../src/renderer/features/dialogue-desk/drafts.ts";
import { createRecord, putRecord, records } from "../src/renderer/features/rewrite/records.ts";

test("disconnected edits to an existing dialogue draft merge both writers' text and undo locally", () => {
  const first = DocumentSession.untitled(), id = first.doc.paragraphs()[0]!.id;
  saveDialogueDraft(first, id, "Hello.", "Hello there.");
  const second = new DocumentSession(ScreenplayDoc.fromUpdate(first.doc.encodeState()));
  first.undo.clear();
  second.undo.clear();
  try {
    saveDialogueDraft(first, id, "Hello.", "Hello there, Alice.");
    saveDialogueDraft(second, id, "Hello.", "Well, Hello there.");
    const firstUpdate = Y.encodeStateAsUpdate(first.doc.ydoc);
    const secondUpdate = Y.encodeStateAsUpdate(second.doc.ydoc);
    Y.applyUpdate(first.doc.ydoc, secondUpdate);
    Y.applyUpdate(second.doc.ydoc, firstUpdate);
    const merged = { base: "Hello.", text: "Well, Hello there, Alice." };
    assert.deepEqual(dialogueDraft(first, id), merged);
    assert.deepEqual(dialogueDraft(second, id), merged);
    first.undo.undo();
    assert.equal(dialogueDraft(first, id)?.text, "Well, Hello there.");
    assert.equal(first.dirty, true);
    assert(nativeOnlyFeatures(first.doc).includes("Alternate dialogue / action"));
  } finally {
    first.destroy();
    second.destroy();
  }
});

test("disconnected migrations of legacy dialogue drafts retain both editable versions", () => {
  const first = DocumentSession.untitled(), id = first.doc.paragraphs()[0]!.id;
  first.edit(() => putRecord(first.doc, createRecord("alternative", "Dialogue draft", "Hello there.", {
    dialogueDraft: { paragraphId: id, base: "Hello." },
  })));
  const second = new DocumentSession(ScreenplayDoc.fromUpdate(first.doc.encodeState()));
  try {
    saveDialogueDraft(first, id, "Hello.", "Hello there, Alice.");
    saveDialogueDraft(second, id, "Hello.", "Well, Hello there.");
    const firstUpdate = first.doc.encodeState(), secondUpdate = second.doc.encodeState();
    Y.applyUpdate(first.doc.ydoc, secondUpdate);
    Y.applyUpdate(second.doc.ydoc, firstUpdate);
    const expected = ["Hello there, Alice.", "Well, Hello there."].sort();
    for (const session of [first, second]) {
      assert.deepEqual(dialogueDraftRecords(session, id).map(record => record.text).sort(), expected);
      assert.equal(records(session.doc, "alternative").length, 2);
    }
    const own = dialogueDraftRecords(first, id).find(record => record.text === expected[0])!;
    saveDialogueDraft(first, id, "Hello.", "Hello there, Alice!", own.id);
    assert.equal(dialogueDraft(first, id, own.id)?.text, "Hello there, Alice!");
  } finally {
    first.destroy();
    second.destroy();
  }
});

test("typing back to the source wording preserves a disconnected writer's new text", () => {
  const first = DocumentSession.untitled(), id = first.doc.paragraphs()[0]!.id;
  saveDialogueDraft(first, id, "Hello.", "Hello there.");
  const second = new DocumentSession(ScreenplayDoc.fromUpdate(first.doc.encodeState()));
  try {
    saveDialogueDraft(first, id, "Hello.", "Hello.");
    assert.equal(dialogueDraft(first, id), undefined);
    saveDialogueDraft(second, id, "Hello.", "Well, Hello there.");
    const firstUpdate = first.doc.encodeState(), secondUpdate = second.doc.encodeState();
    Y.applyUpdate(first.doc.ydoc, secondUpdate);
    Y.applyUpdate(second.doc.ydoc, firstUpdate);
    assert.equal(dialogueDraft(first, id)?.text, "Well, Hello.");
    assert.deepEqual(dialogueDraft(first, id), dialogueDraft(second, id));
  } finally {
    first.destroy();
    second.destroy();
  }
});

test("dialogue drafts mark the session dirty and survive native recovery without applying to the script", () => {
  const session = DocumentSession.untitled(), id = session.doc.paragraphs()[0]!.id;
  saveDialogueDraft(session, id, "", "A different line.");
  assert.equal(session.dirty, true);
  assert(nativeOnlyFeatures(session.doc).includes("Alternate dialogue / action"));
  assert.equal(session.doc.paragraph(id).runs.length, 0);
  const reopened = new DocumentSession(ScreenplayDoc.fromUpdate(session.doc.encodeState()));
  assert.deepEqual(dialogueDraft(reopened, id), { base: "", text: "A different line." });
  saveDialogueDraft(reopened, id, "", "");
  assert.equal(dialogueDraft(reopened, id), undefined);
  session.undo.undo();
  assert.equal(dialogueDraft(session, id), undefined);
  session.destroy();
  reopened.destroy();
});

test("dialogue draft diffs preserve Unicode and drafts survive flattened snapshot metadata", () => {
  const session = DocumentSession.untitled(), restored = DocumentSession.untitled();
  const id = session.doc.paragraphs()[0]!.id;
  try {
    saveDialogueDraft(session, id, "Hello", "Hello 😀");
    saveDialogueDraft(session, id, "Hello", "Hello 😁");
    assert.equal(dialogueDraft(session, id)?.text, "Hello 😁");
    restored.edit(() => {
      for (const [key, value] of Object.entries(session.doc.meta.toJSON())) restored.doc.meta.set(key, value);
    });
    assert.equal(dialogueDraft(restored, id)?.text, "Hello 😁");
    saveDialogueDraft(restored, id, "Hello", "Hello again 😁");
    assert.equal(dialogueDraft(restored, id)?.text, "Hello again 😁");
  } finally {
    session.destroy();
    restored.destroy();
  }
});

test("read-only dialogue drafts cannot change document metadata", () => {
  const session = DocumentSession.untitled();
  session.setReadOnly(true);
  assert.throws(() => saveDialogueDraft(session, "p", "old", "new"), /read-only/);
  assert.equal(session.dirty, false);
  session.destroy();
});

test("an edit form opened before a co-writer's Dialogue Desk typing refuses to save over it", () => {
  const first = DocumentSession.untitled(), id = first.doc.paragraphs()[0]!.id;
  saveDialogueDraft(first, id, "Hello.", "Hello there.");
  const second = new DocumentSession(ScreenplayDoc.fromUpdate(first.doc.encodeState()));
  try {
    // A opens the draft's edit form in Notes.
    const opened = dialogueDraftRecords(first, id)[0]!;
    // B types in Dialogue Desk and the change arrives.
    saveDialogueDraft(second, id, "Hello.", "Hello there, friend.");
    Y.applyUpdate(first.doc.ydoc, Y.encodeStateAsUpdate(second.doc.ydoc));
    // A changes only the title and saves the stale form.
    assert.throws(() => first.edit(() => putRecord(first.doc, { ...opened, title: "Renamed" }, opened.revision)), /changed/);
    assert.equal(dialogueDraft(first, id)?.text, "Hello there, friend.");
  } finally {
    first.destroy();
    second.destroy();
  }
});

test("a draft typed back to its source starts from the script's new line after that line changes", () => {
  const session = DocumentSession.untitled(), id = session.doc.paragraphs()[0]!.id;
  try {
    saveDialogueDraft(session, id, "Hello.", "Hello there.");
    saveDialogueDraft(session, id, "Hello.", "Hello.");
    assert.equal(dialogueDraft(session, id), undefined);
    // The script's line becomes "Hi." and the writer drafts from it.
    saveDialogueDraft(session, id, "Hi.", "Hi, you.");
    assert.deepEqual(dialogueDraft(session, id), { base: "Hi.", text: "Hi, you." });
  } finally {
    session.destroy();
  }
});

test("undoing one writer's typing keeps a draft that also holds a co-writer's text, whichever client ID is higher", () => {
  for (const [a, b] of [[200, 100], [100, 200]] as const) {
    const first = DocumentSession.untitled(), id = first.doc.paragraphs()[0]!.id;
    saveDialogueDraft(first, id, "Hello.", "Hello there.");
    const second = new DocumentSession(ScreenplayDoc.fromUpdate(first.doc.encodeState()));
    first.doc.ydoc.clientID = a;
    second.doc.ydoc.clientID = b;
    first.undo.clear();
    try {
      saveDialogueDraft(first, id, "Hello.", "Hello there, Alice.");
      saveDialogueDraft(second, id, "Hello.", "Well, Hello there.");
      const one = Y.encodeStateAsUpdate(first.doc.ydoc), two = Y.encodeStateAsUpdate(second.doc.ydoc);
      Y.applyUpdate(first.doc.ydoc, two);
      Y.applyUpdate(second.doc.ydoc, one);
      first.undo.undo();
      Y.applyUpdate(second.doc.ydoc, Y.encodeStateAsUpdate(first.doc.ydoc));
      assert.equal(dialogueDraft(first, id)?.text, "Well, Hello there.");
      assert.equal(dialogueDraft(second, id)?.text, "Well, Hello there.");
    } finally {
      first.destroy();
      second.destroy();
    }
  }
});

test("an edit form opened before a co-writer's Undo refuses to save over the restored text", () => {
  const first = DocumentSession.untitled(), id = first.doc.paragraphs()[0]!.id;
  saveDialogueDraft(first, id, "Hello.", "Hello there, Bob.");
  const second = new DocumentSession(ScreenplayDoc.fromUpdate(first.doc.encodeState()));
  second.undo.clear();
  try {
    saveDialogueDraft(second, id, "Hello.", "Hello there.");
    Y.applyUpdate(first.doc.ydoc, Y.encodeStateAsUpdate(second.doc.ydoc));
    const opened = dialogueDraftRecords(first, id)[0]!;
    second.undo.undo();
    Y.applyUpdate(first.doc.ydoc, Y.encodeStateAsUpdate(second.doc.ydoc));
    assert.equal(dialogueDraft(first, id)?.text, "Hello there, Bob.");
    assert.throws(() => first.edit(() => putRecord(first.doc, { ...opened, title: "Renamed" }, opened.revision)), /changed/);
    assert.equal(dialogueDraft(first, id)?.text, "Hello there, Bob.");
  } finally {
    first.destroy();
    second.destroy();
  }
});
