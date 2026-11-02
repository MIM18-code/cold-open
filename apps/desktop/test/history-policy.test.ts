import assert from "node:assert/strict";
import test from "node:test";
import { ScreenplayDoc } from "@screenplay/engine";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { automaticSnapshotDue } from "../src/renderer/features/history/policy.ts";

function opened(): DocumentSession {
  const session = new DocumentSession(ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "h", type: "sceneHeading", runs: [{ text: "INT. HALL - DAY" }] },
  ] }), { path: "/scripts/hall.screenplay" });
  session.dirty = false;
  return session;
}

test("a script opened and left alone is never snapshotted, so it is never marked edited", () => {
  const versions = new WeakMap<DocumentSession, number>();
  const session = opened();
  assert.equal(automaticSnapshotDue(versions, session), false);
  assert.equal(automaticSnapshotDue(versions, session), false);
  assert.equal(session.dirty, false);
});

test("an edit after opening makes the next tick snapshot", () => {
  const versions = new WeakMap<DocumentSession, number>();
  const session = opened();
  automaticSnapshotDue(versions, session);
  session.edit(() => session.doc.insertText("h", 0, "X"));
  assert.equal(automaticSnapshotDue(versions, session), true);
});

test("edits made before the first tick are snapshotted on it", () => {
  const versions = new WeakMap<DocumentSession, number>();
  const session = opened();
  session.edit(() => session.doc.insertText("h", 0, "X"));
  assert.equal(automaticSnapshotDue(versions, session), true);
});
