import assert from "node:assert/strict";
import test from "node:test";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { captureAnchor, insertSpoken, QuickNote } from "../src/renderer/features/quick-notes/quick-note.ts";
import { nextSeenAt, pruneDismissed, readSeen, relativeTime, trayNotes } from "../src/renderer/features/quick-notes/since.ts";
import { createRecord, putRecord, records, resolveAnchor, type ProjectRecord } from "../src/renderer/features/rewrite/records.ts";
import { plainSpeechError } from "../src/renderer/features/dictation/messages.ts";

const T = (minutes: number) => Date.UTC(2026, 10, 3, 9, minutes);
function note(id: string, minutes: number, extra: Partial<ProjectRecord> = {}): ProjectRecord {
  return { ...createRecord("note", "", `Text ${id}`, { author: "Phone", ...extra }), id, created: new Date(T(minutes)).toISOString() };
}
const input = (list: ProjectRecord[], extra: Partial<Parameters<typeof trayNotes>[0]> = {}) =>
  ({ records: list, baseline: T(10), dismissed: new Set<string>(), own: new Set<string>(), ...extra });
const ids = (list: ProjectRecord[]) => list.map((r) => r.id);

test("the tray lists unresolved notes created after the baseline, newest first", () => {
  const list = [note("a", 5), note("b", 11), note("c", 20), note("d", 15)];
  assert.deepEqual(ids(trayNotes(input(list))), ["c", "d", "b"]);
});

test("a script this Mac has not seen before shows nothing", () => {
  assert.deepEqual(trayNotes(input([note("a", 50)], { baseline: null })), []);
});

test("resolved notes, replies, dismissed notes and the writer's own notes stay out", () => {
  const list = [
    note("resolved", 12, { resolved: true }), note("reply", 13, { parentId: "x" }), note("dismissed", 14), note("own", 15), note("shown", 16),
    { ...note("bookmark", 17), kind: "bookmark" as const },
  ];
  const shown = trayNotes(input(list, { dismissed: new Set(["dismissed"]), own: new Set(["own"]) }));
  assert.deepEqual(ids(shown), ["shown"]);
});

test("a note created exactly at the baseline belongs to the earlier session", () => {
  assert.deepEqual(trayNotes(input([note("edge", 10)])), []);
});

test("last-seen moves to now unless a note arrived that was never shown", () => {
  const now = T(100);
  assert.equal(nextSeenAt(now, T(10), [], new Set()), now);
  assert.equal(nextSeenAt(now, T(10), [note("a", 40)], new Set(["a"])), now);
  assert.equal(nextSeenAt(now, T(10), [note("a", 40), note("b", 50)], new Set()), T(40) - 1);
  assert.equal(nextSeenAt(now, T(10), [note("a", 40), note("b", 50)], new Set(["a"])), T(50) - 1);
  // It never goes backwards, and a first visit has no earlier time to keep.
  assert.equal(nextSeenAt(now, T(60), [note("a", 40)], new Set()), T(60));
  assert.equal(nextSeenAt(now, null, [], new Set()), now);
});

test("stored memory is validated and trimmed", () => {
  assert.equal(readSeen(null), null);
  assert.equal(readSeen({ seenAt: "x" }), null);
  assert.deepEqual(readSeen({ seenAt: 5, dismissed: ["a", 7, "b"] }), { seenAt: 5, dismissed: ["a", "b"] });
  assert.deepEqual(readSeen({ seenAt: 5 }), { seenAt: 5, dismissed: [] });
  assert.deepEqual(pruneDismissed(["a", "gone", "b"], new Set(["a", "b"])), ["a", "b"]);
});

test("relative times read plainly", () => {
  const now = T(600);
  assert.equal(relativeTime(now - 10_000, now), "just now");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5 min ago");
  assert.equal(relativeTime(now - 3 * 3600_000, now), "3 h ago");
  assert.equal(relativeTime(now - 30 * 3600_000, now), "yesterday");
  assert.equal(relativeTime(now - 3 * 86400_000, now), "3 days ago");
});

test("a quick note is created on the first words, follows the typing and is gone when the box is emptied", () => {
  const session = DocumentSession.untitled();
  try {
    const created: string[] = [];
    const quick = new QuickNote(session, { author: "Ana", onCreate: (id) => created.push(id) });
    assert.equal(quick.save(""), "none");
    assert.equal(quick.save("   "), "none");
    assert.equal(records(session.doc, "note").length, 0);
    assert.equal(quick.save("Cut the"), "created");
    assert.equal(quick.save("Cut the toast.  "), "updated");
    assert.equal(quick.save("Cut the toast."), "none");
    const [saved] = records(session.doc, "note");
    assert.equal(saved!.text, "Cut the toast.");
    assert.equal(saved!.author, "Ana");
    assert.equal(saved!.anchor, undefined);
    assert.deepEqual(created, [saved!.id]);
    assert.equal(quick.save(""), "removed");
    assert.equal(records(session.doc, "note").length, 0);
    assert.equal(quick.save("Back again"), "created");
    // Typing again after emptying the box brings back the same note.
    assert.equal(records(session.doc, "note")[0]!.id, saved!.id);
  } finally {
    session.destroy();
  }
});

test("typing a note and finishing is one undo step", () => {
  const session = DocumentSession.untitled();
  try {
    const quick = new QuickNote(session, { author: "Ana" });
    quick.save("A");
    quick.save("A long");
    quick.finish("A long idea");
    assert.equal(records(session.doc, "note")[0]!.text, "A long idea");
    session.undo.undo();
    assert.equal(records(session.doc, "note").length, 0);
  } finally {
    session.destroy();
  }
});

test("a note written elsewhere with the same id is recreated, not lost", () => {
  const session = DocumentSession.untitled();
  try {
    const quick = new QuickNote(session, { author: "Ana" });
    quick.save("First");
    session.edit(() => session.doc.meta.delete(`workbench.record.${quick.id}`));
    assert.equal(quick.exists, false);
    assert.equal(quick.save("First, and more"), "created");
    assert.equal(records(session.doc, "note")[0]!.text, "First, and more");
  } finally {
    session.destroy();
  }
});

test("a read-only script refuses the note and leaves no record", () => {
  const session = DocumentSession.untitled();
  try {
    session.setReadOnly(true);
    const quick = new QuickNote(session, { author: "Ana" });
    assert.throws(() => quick.save("Nope"), /read-only/);
    assert.equal(quick.id, null);
    session.setReadOnly(false);
    assert.equal(quick.save("Now fine"), "created");
  } finally {
    session.destroy();
  }
});

test("a note attaches to the selection, else the caret's line, else nothing", () => {
  const session = DocumentSession.untitled();
  try {
    const first = session.doc.paragraphs()[0]!.id;
    session.edit(() => session.doc.insertText(first, 0, "INT. KITCHEN - DAY"));
    assert.equal(captureAnchor(session, null, null), undefined);
    assert.equal(captureAnchor(session, null, "missing"), undefined);
    const line = captureAnchor(session, null, first)!;
    assert.equal(line.paragraphId, first);
    const picked = captureAnchor(session, { anchor: { paragraphId: first, offset: 8 }, head: { paragraphId: first, offset: 4 } }, null)!;
    assert.equal(picked.quote, " KIT");
    assert.deepEqual(resolveAnchor(session.doc, picked), { paragraphId: first, from: 4, to: 8 });
    const quick = new QuickNote(session, { author: "Ana", anchor: picked });
    quick.save("Warmer light");
    assert.equal(records(session.doc, "note")[0]!.anchor?.paragraphId, first);
  } finally {
    session.destroy();
  }
});

test("pinning a tray note uses putRecord with the expected revision", () => {
  const session = DocumentSession.untitled();
  try {
    const first = session.doc.paragraphs()[0]!.id;
    const phone = createRecord("note", "Phone note", "Check the timeline", { author: "Phone" });
    session.edit(() => putRecord(session.doc, phone));
    const stored = records(session.doc, "note")[0]!;
    const anchor = captureAnchor(session, null, first)!;
    session.edit(() => putRecord(session.doc, { ...stored, anchor }, stored.revision));
    assert.equal(records(session.doc, "note")[0]!.anchor?.paragraphId, first);
    assert.throws(() => session.edit(() => putRecord(session.doc, { ...stored, resolved: true }, stored.revision)), /changed/);
  } finally {
    session.destroy();
  }
});

test("spoken words join the note at the caret with tidy spacing", () => {
  assert.deepEqual(insertSpoken("", 0, 0, " Hello there. "), { text: "Hello there.", caret: 12 });
  assert.deepEqual(insertSpoken("Cut this", 8, 8, "and that."), { text: "Cut this and that.", caret: 18 });
  assert.deepEqual(insertSpoken("Cut this ", 9, 9, "and that."), { text: "Cut this and that.", caret: 18 });
  assert.deepEqual(insertSpoken("Start end", 5, 5, "middle"), { text: "Start middle end", caret: 12 });
  assert.deepEqual(insertSpoken("Replace me now", 8, 10, "this"), { text: "Replace this now", caret: 12 });
  assert.deepEqual(insertSpoken("Keep", 4, 4, "   "), { text: "Keep", caret: 4 });
});

test("dictation failures read as one plain sentence that says what to do", () => {
  assert.match(plainSpeechError(Object.assign(new Error("x"), { name: "NotAllowedError" })), /Privacy & Security > Microphone/);
  assert.match(plainSpeechError(new Error("The speech helper was not found at /x. Build it with ...")), /Settings > Dictation/);
  assert.match(plainSpeechError(new Error("No speech was found in the recording.")), /No speech heard/);
  assert.equal(plainSpeechError(new Error("Something odd\nstack line")), "Something odd");
});

test("a co-writer's edit to the note while the box is open is refused, not overwritten", () => {
  const session = DocumentSession.untitled();
  try {
    const quick = new QuickNote(session, { author: "Ana" });
    quick.save("Trim the");
    quick.save("Trim the scene");
    const stored = records(session.doc, "note")[0]!;
    session.edit(() => putRecord(session.doc, { ...stored, text: "Dana: keep the scene" }, stored.revision));
    assert.throws(() => quick.save("Trim the scene ending"), /changed/);
    assert.equal(records(session.doc, "note")[0]!.text, "Dana: keep the scene");
  } finally {
    session.destroy();
  }
});

test("a quick note is claimed as the writer's own before the document announces it", () => {
  const session = DocumentSession.untitled();
  const claimed: string[] = [], seenUnclaimed: string[] = [];
  const watch = () => { for (const r of records(session.doc, "note")) if (!claimed.includes(r.id)) seenUnclaimed.push(r.id); };
  session.doc.meta.observe(watch);
  try {
    new QuickNote(session, { author: "Ana", onCreate: (id) => claimed.push(id) }).save("My own idea");
    assert.equal(claimed.length, 1);
    assert.deepEqual(seenUnclaimed, []);
  } finally {
    session.doc.meta.unobserve(watch);
    session.destroy();
  }
});
