import assert from "node:assert/strict";
import test from "node:test";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { filePhoneNotes } from "../src/renderer/features/phone/receipts.ts";
import { records, resolveAnchor } from "../src/renderer/features/rewrite/records.ts";

const item = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "note", text: `Note ${id}`, paragraphId: "", sourceText: "", deviceId: "device-0000001", ...extra });

test("phone notes go straight into project notes, attached when their passage exists, and only once", async () => {
  const s = DocumentSession.untitled();
  const paragraphId = s.doc.paragraphs()[0]!.id;
  s.edit(() => s.doc.insertText(paragraphId, 0, "Nora sets a thermos on the counter."));
  const acknowledged: string[] = [];
  const ack = async (id: string) => { acknowledged.push(id); };
  const inbox = [item("loose-note-0001"), item("pinned-note-001", { paragraphId, sourceText: "Nora sets a thermos" }),
    item("moved-note-0001", { paragraphId: "gone-paragraph", sourceText: "Text that was cut." }),
    { ...item("draft-item-0001"), kind: "draft" }];
  try {
    assert.equal(await filePhoneNotes(s, inbox, () => true, ack), 3);
    const notes = records(s.doc, "note");
    assert.deepEqual(notes.map(n => n.author), ["Phone", "Phone", "Phone"]);
    assert.equal(resolveAnchor(s.doc, notes.find(n => n.text === "Note pinned-note-001")!.anchor)?.paragraphId, paragraphId);
    assert.equal(notes.find(n => n.text === "Note loose-note-0001")!.anchor, undefined);
    assert.equal(notes.find(n => n.text === "Note moved-note-0001")!.anchor, undefined, "a changed passage still keeps the note");
    assert.deepEqual(acknowledged, ["loose-note-0001", "pinned-note-001", "moved-note-0001"], "drafts still wait for review");
    assert.equal(await filePhoneNotes(s, inbox, () => true, ack), 0, "a redelivered note is not added twice");
    assert.equal(records(s.doc, "note").length, 3);
  } finally { s.destroy(); }
});

test("read-only scripts leave phone notes in the inbox", async () => {
  const s = DocumentSession.untitled();
  s.setReadOnly(true);
  const acknowledged: string[] = [];
  try {
    assert.equal(await filePhoneNotes(s, [item("readonly-note-01")], () => true, async id => { acknowledged.push(id); }), 0);
    assert.deepEqual(acknowledged, []);
  } finally { s.destroy(); }
});
