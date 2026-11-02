import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKLOT_BASELINE, omitScene, parseFdx, parseFountain, backlotChanges, productionSnapshot, ScreenplayDoc, writeFdx } from "@screenplay/engine";
import * as Y from "yjs";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { ProductionBaselineStore } from "../src/main/production/baseline-store.ts";
import { PRODUCTION_BASELINE } from "../src/shared/channels/production-baseline.ts";

const root = await mkdtemp(join(tmpdir(), "production-session-"));
const store = new ProductionBaselineStore(root);
Object.assign(globalThis, { window: { desktop: { invoke: (channel: string, path: string, value: unknown) => {
  if (channel === PRODUCTION_BASELINE.get) return store.get(path);
  if (channel === PRODUCTION_BASELINE.set) return store.set(path, value);
  throw new Error(channel);
} } } });
const { acceptProductionBaseline, persistProductionBaseline, prepareProductionBaselineSave, restoreProductionBaseline, sessionBaseline } =
  await import("../src/renderer/features/backlot/baseline.ts");
test.after(async () => { await rm(root, { recursive: true, force: true }); });

const baseline = { version: 1 as const, scenes: [], sentAt: "2026-11-01", projectId: "project" };
const handoffRecords = (session: DocumentSession) => [...session.doc.meta.entries()].filter(([key]) => key.startsWith(BACKLOT_BASELINE + "."));

test("Save As carries a baseline to the new path while retaining the original copy", async () => {
  const session = DocumentSession.untitled();
  await writeFile(join(root, "Original.fdx"), "original");
  session.markSaved(join(root, "Original.fdx"), "fdx", "Original");
  await acceptProductionBaseline(session, baseline);
  assert.equal(session.doc.meta.has(BACKLOT_BASELINE), false);
  const carried = prepareProductionBaselineSave(session, "fountain");
  await writeFile(join(root, "Copy.fountain"), "copy");
  session.markSaved(join(root, "Copy.fountain"), "fountain", "Copy");
  await persistProductionBaseline(session, carried);
  assert.deepEqual((await store.get(join(root, "Original.fdx")))?.baseline, baseline);
  assert.deepEqual((await store.get(join(root, "Copy.fountain")))?.baseline, baseline);
  const reopened = DocumentSession.untitled();
  reopened.markSaved(session.path!, "fountain", "Copy");
  await restoreProductionBaseline(reopened);
  assert.deepEqual(sessionBaseline(reopened), baseline);
  prepareProductionBaselineSave(session, "screenplay");
  const native = new DocumentSession(ScreenplayDoc.fromUpdate(session.doc.encodeState()));
  assert.deepEqual(sessionBaseline(native), baseline);
  session.destroy(); reopened.destroy(); native.destroy();
});

test("untitled handoffs carry over to the first save", async () => {
  const session = DocumentSession.untitled();
  await acceptProductionBaseline(session, baseline);
  assert.equal(session.doc.meta.has(BACKLOT_BASELINE), false);
  assert.deepEqual(sessionBaseline(session), baseline);
  prepareProductionBaselineSave(session, "fdx");
  await writeFile(join(root, "First.fdx"), "first");
  session.markSaved(join(root, "First.fdx"), "fdx", "First");
  await persistProductionBaseline(session, baseline);
  assert.deepEqual((await store.get(session.path!))?.baseline, baseline);
  session.destroy();
});

test("Fountain reopening restores saved scene identities and preserves heading changes since handoff", async () => {
  const source = "INT. ROOM - DAY\n\nA car waits.\n";
  const original = new DocumentSession(ScreenplayDoc.fromScript(parseFountain(source)), { path: join(root, "Identity.fountain"), format: "fountain" });
  await writeFile(original.path!, source);
  original.fileHash = "a".repeat(64);
  const before = { ...productionSnapshot(original.script()), sentAt: baseline.sentAt, projectId: baseline.projectId };
  await acceptProductionBaseline(original, before);
  const heading = original.script().paragraphs[0]!;
  original.edit(() => original.doc.replaceText(heading.id, 0, 15, "INT. KITCHEN - NIGHT"));
  original.markSaved(original.path!, "fountain", "Identity");
  await writeFile(original.path!, source.replace("ROOM - DAY", "KITCHEN - NIGHT"));
  original.fileHash = "b".repeat(64);
  await persistProductionBaseline(original, before);
  const reopen = () => new DocumentSession(ScreenplayDoc.fromScript(parseFountain(source.replace("ROOM - DAY", "KITCHEN - NIGHT"))), { path: original.path, format: "fountain" });
  const reopened = reopen(); reopened.fileHash = original.fileHash;
  await restoreProductionBaseline(reopened);
  const changes = backlotChanges(sessionBaseline(reopened), productionSnapshot(reopened.script()));
  assert.deepEqual(changes.scenes.map(s => s.kinds), [["heading"]]);
  assert.equal(reopened.dirty, false);
  const external = reopen(); external.fileHash = "c".repeat(64);
  const externalId = external.script().paragraphs[0]!.id;
  await restoreProductionBaseline(external);
  assert.equal(external.script().paragraphs[0]!.id, externalId);
  original.destroy(); reopened.destroy(); external.destroy();
});

test("FDX without IDs keeps the saved identities when a handoff follows unsaved edits", async () => {
  const xml = '<FinalDraft DocumentType="Script" Template="No" Version="1"><Content><Paragraph Type="Scene Heading"><Text>INT. ROOM - DAY</Text></Paragraph></Content></FinalDraft>';
  const create = () => new DocumentSession(ScreenplayDoc.fromScript(parseFdx(xml)), { path: join(root, "NoIds.fdx"), format: "fdx" });
  await writeFile(join(root, "NoIds.fdx"), xml);
  const session = create(); session.fileHash = "d".repeat(64);
  await restoreProductionBaseline(session);
  const id = session.script().paragraphs[0]!.id;
  session.edit(() => session.doc.replaceText(id, 0, 15, "INT. KITCHEN - NIGHT"));
  const sent = { ...productionSnapshot(session.script()), sentAt: baseline.sentAt, projectId: baseline.projectId };
  await acceptProductionBaseline(session, sent);
  const reopened = create(); reopened.fileHash = session.fileHash;
  await restoreProductionBaseline(reopened);
  assert.equal(reopened.script().paragraphs[0]!.id, id);
  assert.deepEqual(backlotChanges(sessionBaseline(reopened), productionSnapshot(reopened.script())).scenes.map(s => s.kinds), [["heading"]]);
  session.destroy(); reopened.destroy();
});

for (const format of ["screenplay", "fdx"] as const) test(`${format} concurrent handoffs converge on the latest accepted revision even when its client's ID is lower`, async () => {
  const first = DocumentSession.untitled();
  first.markSaved(join(root, "Concurrent." + format), format, "Concurrent");
  if (format === "fdx") await writeFile(first.path!, writeFdx(first.script()));
  const second = new DocumentSession(ScreenplayDoc.fromUpdate(first.doc.encodeState()), { path: first.path, format });
  first.doc.ydoc.clientID = 200;
  second.doc.ydoc.clientID = 100;
  const older = { ...baseline, revision: 7, sentAt: "2026-11-01T00:00:02Z" };
  const newer = { ...baseline, revision: 8, sentAt: "2026-11-01T00:00:01Z" };
  await acceptProductionBaseline(first, older);
  await acceptProductionBaseline(second, newer);
  const a = first.doc.encodeState(), b = second.doc.encodeState();
  Y.applyUpdate(first.doc.ydoc, b);
  Y.applyUpdate(second.doc.ydoc, a);
  assert.deepEqual(sessionBaseline(first), newer);
  assert.deepEqual(sessionBaseline(second), newer);
  const reopened = new DocumentSession(ScreenplayDoc.fromUpdate(first.doc.encodeState()), { path: first.path, format: "screenplay" });
  assert.deepEqual(sessionBaseline(reopened), newer);
  // After seeing both concurrent records, even a delayed older acceptance compacts to the winner.
  await acceptProductionBaseline(first, older);
  assert.equal(handoffRecords(first).length, 1);
  assert.deepEqual(sessionBaseline(first), newer);
  Y.applyUpdate(second.doc.ydoc, first.doc.encodeState());
  assert.equal(handoffRecords(second).length, 1);
  assert.deepEqual(sessionBaseline(second), newer);
  if (format === "fdx") assert.deepEqual((await store.get(first.path!))?.baseline, newer);
  first.destroy(); second.destroy(); reopened.destroy();
});

test("acceptance keeps only the latest handoff per project across native saves", async () => {
  const session = DocumentSession.untitled();
  session.doc.meta.set("unrelated", "retained");
  const b = { ...baseline, projectId: "other-project", revision: 2, sentAt: "2026-11-01T00:00:02Z" };
  await acceptProductionBaseline(session, b);
  const snapshot = productionSnapshot(session.script());
  for (let revision = 1; revision <= 252; revision++) {
    await acceptProductionBaseline(session, { ...baseline, ...snapshot, revision, sentAt: "2026-11-01T00:00:01Z" });
    assert.equal(handoffRecords(session).length, 2);
  }
  const a = { ...baseline, ...snapshot, revision: 252, sentAt: "2026-11-01T00:00:01Z" };
  assert.deepEqual(sessionBaseline(session), b);
  assert.deepEqual(sessionBaseline(session, baseline.projectId), a);
  assert.deepEqual(sessionBaseline(session, b.projectId), b);
  assert.equal(sessionBaseline(session, "unsent-project"), null);
  const reopened = new DocumentSession(ScreenplayDoc.fromUpdate(session.doc.encodeState()));
  assert.equal(handoffRecords(reopened).length, 2);
  assert.deepEqual(sessionBaseline(reopened, baseline.projectId), a);
  assert.deepEqual(sessionBaseline(reopened, b.projectId), b);
  assert.equal(reopened.doc.meta.get("unrelated"), "retained");
  session.destroy(); reopened.destroy();
});

test("FDX scene mappings survive an external edit and insertion beside an omitted scene", async () => {
  const original = DocumentSession.untitled();
  original.markSaved(join(root, "External.fdx"), "fdx", "External");
  original.edit(() => original.doc.load({ titlePage: [], paragraphs: [
    { id: "12222222-2222-4222-8222-222222222222", sceneId: "stable-omitted", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] },
    { id: "23333333-3333-4333-8333-333333333333", sceneId: "stable-road", type: "sceneHeading", runs: [{ text: "EXT. ROAD - NIGHT" }] },
  ] }));
  original.edit(() => omitScene(original.doc, "stable-omitted"));
  await writeFile(original.path!, writeFdx(original.script()));
  original.fileHash = "e".repeat(64);
  original.markSaved(original.path!, "fdx", "External");
  const sent = { ...productionSnapshot(original.script()), sentAt: baseline.sentAt, projectId: baseline.projectId };
  await acceptProductionBaseline(original, sent);
  const edited = parseFdx(writeFdx(original.script()).replace("ROAD - NIGHT", "ROAD - DAY"));
  edited.paragraphs.unshift({ id: "new-heading", type: "sceneHeading", runs: [{ text: "EXT. FIELD - DAY" }] });
  const reopened = new DocumentSession(ScreenplayDoc.fromScript(edited), { path: original.path, format: "fdx" });
  await writeFile(original.path!, writeFdx(edited));
  reopened.fileHash = "f".repeat(64);
  await restoreProductionBaseline(reopened);
  const changes = backlotChanges(sessionBaseline(reopened), productionSnapshot(reopened.script()));
  assert.deepEqual(changes.scenes.map(s => s.kinds), [["added"], ["heading"]]);
  assert.equal(reopened.script().paragraphs.find(p => p.runs[0]?.text === "OMITTED")?.sceneId, "stable-omitted");
  original.destroy(); reopened.destroy();
});
