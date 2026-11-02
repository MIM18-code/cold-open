import test from "node:test";
import assert from "node:assert/strict";
import { ScreenplayDoc, productionChanges, setRevisionState, omitScene, applyTag, tagDefinitions, addDeletionMark } from "@screenplay/engine";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { acceptPhoneRecord } from "../src/renderer/features/phone/receipts.ts";
import { createRecord, records } from "../src/renderer/features/rewrite/records.ts";
import { validateSnapshot } from "../src/main/phone/server.ts";

const set = { id: "1", name: "Blue", color: "#abcdef", mark: "*", date: "11/01/26", style: "" };
function script() {
  const doc = new ScreenplayDoc();
  doc.insertParagraph(0, { id: "h1", type: "sceneHeading", sceneId: "s1", sceneNumber: "1", runs: [{ text: "INT. ROOM - DAY" }] });
  doc.insertParagraph(1, { id: "a", type: "action", runs: [{ text: "A cup." }] });
  doc.insertParagraph(2, { id: "h2", type: "sceneHeading", sceneId: "s2", sceneNumber: "1A", runs: [{ text: "EXT. ROAD - DAY" }] });
  return doc;
}

test("production publishes revision colors, omitted and A-scenes, locks and changed breakdown tags", () => {
  const doc = script(), baseline = structuredClone([...doc.paragraphs()]);
  setRevisionState(doc, { sets: [set], currentSetId: "1", tracking: true, showMarks: true });
  doc.formatRuns("a", 0, 2, { "fdx:RevisionID": "1" });
  applyTag(doc, { paragraphId: "a", offset: 2 }, { paragraphId: "a", offset: 5 }, "Props", "Cup");
  doc.meta.set("pageLocks", { pages: [{ number: "1", paragraphId: "h1", offset: 0, paragraphIds: ["a"] }] });
  omitScene(doc, "s2");
  const result = productionChanges(doc, baseline);
  assert.deepEqual(result.active, set);
  assert.equal(result.marks.a!.color, set.color);
  assert.deepEqual(result.lockedPages, ["1"]);
  assert.ok(result.scenes[0]!.changes.includes("Breakdown tags changed"));
  assert.ok(result.scenes[0]!.changes.includes("Locked pages 1"));
  assert.ok(result.scenes[1]!.changes.includes("Omitted"));
  assert.ok(result.scenes[1]!.changes.includes("A-scene"));
  const tagged = structuredClone([...doc.paragraphs()]), defs = tagDefinitions(doc.toScript());
  const key = [...doc.meta.keys()].find(k => k.startsWith("fdx.tagDefinition."))!;
  assert.ok(key);
  {
    doc.meta.set(key, { ...(doc.meta.get(key) as object), label: "Red cup" });
    assert.ok(productionChanges(doc, tagged, defs).scenes[0]!.changes.includes("Breakdown tags changed"));
  }
  const snapshot = { title: "Script", revision: "r1", cues: [], production: result, paragraphs: [...doc.paragraphs()] };
  assert.deepEqual(validateSnapshot(snapshot), snapshot);
  assert.deepEqual(validateSnapshot({ title: "Old", revision: "r1", cues: [] }), { title: "Old", revision: "r1", cues: [] });
  doc.ydoc.destroy();
});

for (const destination of ["after", "end"] as const) test(`scene suggestion ${destination} waits for acceptance, inserts once and undoes`, async () => {
  const session = new DocumentSession(script());
  const record = createRecord("cut", "Phone scene suggestion", "New scene");
  const original = session.doc.paragraphs().map(p => p.id);
  const attachment = { paragraphId: "h1", sourceText: "INT. ROOM - DAY", scene: destination,
    elements: [{ type: "sceneHeading" as const, text: "INT. BOAT - NIGHT", uncertainty: "" }] };
  assert.deepEqual(session.doc.paragraphs().map(p => p.id), original);
  assert.equal(await acceptPhoneRecord(session, "scene-message-00001", record, () => true, attachment), true);
  const ps = session.doc.paragraphs();
  assert.equal(ps[destination === "after" ? 2 : ps.length - 1]!.runs[0]!.text, "INT. BOAT - NIGHT");
  assert.equal(await acceptPhoneRecord(session, "scene-message-00001", record, () => true, attachment), false);
  session.undo.undo();
  assert.deepEqual(session.doc.paragraphs().map(p => p.id), original);
  assert.equal(records(session.doc).length, 0);
  session.destroy();
});

test("a stale scene destination and read-only scripts refuse insertion without recording acceptance", async () => {
  const session = new DocumentSession(script());
  const attachment = { paragraphId: "a", sourceText: "A cup.", scene: "after" as const,
    elements: [{ type: "action" as const, text: "New", uncertainty: "" }] };
  await assert.rejects(acceptPhoneRecord(session, "scene-message-00001", createRecord("cut", "Scene", "New"), () => true, attachment), /destination scene/);
  assert.equal(records(session.doc).length, 0);
  session.setReadOnly(true);
  await assert.rejects(acceptPhoneRecord(session, "scene-message-00001", createRecord("cut", "Scene", "New"), () => true, attachment), /editable/);
  session.destroy();
});

test("production marks deletions even when no revised text remains", () => {
  const doc = script();
  setRevisionState(doc, { sets: [set], currentSetId: "1", tracking: true, showMarks: true });
  addDeletionMark(doc, "a", 0, "1");
  const result = productionChanges(doc);
  assert.equal(result.marks.a?.label, "Blue");
  assert.ok(result.scenes[0]?.changes.includes("Revised text"));
  doc.ydoc.destroy();
});

test("a deleted scene cannot resolve to another scene with the same heading", async () => {
  const session = new DocumentSession(script());
  session.edit(() => {
    session.doc.insertParagraph(3, { id: "h3", type: "sceneHeading", sceneId: "s3", runs: [{ text: "INT. ROOM - DAY" }] });
    session.doc.deleteParagraph("h1");
  });
  const before = session.doc.paragraphs();
  await assert.rejects(acceptPhoneRecord(session, "deleted-scene-00001", createRecord("cut", "Scene", "New"), () => true,
    { paragraphId: "h1", sourceText: "INT. ROOM - DAY", scene: "after",
      elements: [{ type: "action", text: "New", uncertainty: "" }] }), /destination scene/);
  assert.deepEqual(session.doc.paragraphs(), before);
  assert.equal(records(session.doc).length, 0);
  assert.equal(await acceptPhoneRecord(session, "deleted-scene-00001", createRecord("cut", "Scene", "New"), () => true,
    { paragraphId: "h3", sourceText: "INT. ROOM - DAY", scene: "after",
      elements: [{ type: "action", text: "New", uncertainty: "" }] }), true);
  assert.equal(session.doc.paragraphs().at(-1)?.runs[0]?.text, "New");
  session.destroy();
});
