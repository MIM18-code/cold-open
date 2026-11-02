import test from "node:test";
import assert from "node:assert/strict";
import { BACKLOT_BASELINE, ScreenplayDoc, applyTag, omitScene, productionSnapshot, backlotChanges, backlotBaseline, isProductionSnapshot, type Script, type BacklotBaseline } from "../src/index.ts";

const script = (): Script => ({ titlePage: [], paragraphs: [
  { id: "h1", sceneId: "s1", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] },
  { id: "a1", type: "action", runs: [{ text: "A red car." }] },
  { id: "c1", type: "character", runs: [{ text: "ADA (V.O.)" }] },
  { id: "d1", type: "dialogue", runs: [{ text: "Hello." }] },
  { id: "h2", sceneId: "s2", type: "sceneHeading", runs: [{ text: "EXT. ROAD - NIGHT" }] },
] });
const baseline = (s = script()): BacklotBaseline => ({ ...productionSnapshot(s), projectId: "project", sentAt: "2026-11-01T00:00:00Z" });

test("unchanged scenes and inserted or removed neighbours do not count as moved", () => {
  const b = baseline(), s = script();
  assert.deepEqual(backlotChanges(b, productionSnapshot(s)).scenes, []);
  s.paragraphs.unshift({ id: "new", type: "sceneHeading", runs: [{ text: "EXT. FIELD - DAY" }] });
  assert.deepEqual(backlotChanges(b, productionSnapshot(s)).scenes.map(s => s.kinds), [["added"]]);
  const removed = script(); removed.paragraphs.splice(0, 4);
  const changes = backlotChanges(b, productionSnapshot(removed));
  assert.deepEqual(changes.scenes[0]!.kinds, ["omitted"]);
  assert.equal(changes.scenes[0]!.after, null);
  assert.equal(changes.baselineSentAt, b.sentAt);
  assert.equal(backlotChanges(null, productionSnapshot(script())).scenes.length, 2);
});

test("stable scene identities detect reordering, heading, cast and eighths changes", () => {
  const b = baseline(), s = script();
  s.paragraphs[0]!.runs = [{ text: "INT. KITCHEN - NIGHT" }];
  s.paragraphs[2]!.runs = [{ text: "BOB" }];
  const snapshot = productionSnapshot(s);
  snapshot.scenes[0]!.eighths = b.scenes[0]!.eighths + 3;
  snapshot.scenes.reverse();
  const changed = backlotChanges(b, snapshot).scenes.find(s => s.sceneId === "s1")!;
  assert.deepEqual(changed.kinds, ["moved", "heading", "characters", "length"]);
  assert.deepEqual(changed.before!.characters, ["ADA"]);
  assert.deepEqual(changed.after!.characters, ["BOB"]);
  assert.equal(changed.eighthsDelta, 3);
  assert.equal(changed.position, 2);
});

test("tags resolve definitions, ignore run splitting, and report removal and omission", () => {
  const doc = new ScreenplayDoc(); doc.load(script());
  const b = baseline(doc.toScript());
  applyTag(doc, { paragraphId: "a1", offset: 2 }, { paragraphId: "a1", offset: 9 }, "Vehicles", "Red car");
  const tagged = productionSnapshot(doc.toScript());
  assert.equal(tagged.scenes[0]!.tags[0]!.label, "Red car");
  assert.ok(backlotChanges(b, tagged).scenes[0]!.kinds.includes("tags"));
  const next = { ...b, scenes: tagged.scenes };
  const split = doc.toScript();
  const run = split.paragraphs[1]!.runs.find(r => r.fdx?.TagNumber)!;
  split.paragraphs[1]!.runs = [{ ...run, text: "red " }, { ...run, text: "car" }];
  assert.deepEqual(productionSnapshot(split).scenes[0]!.tags, tagged.scenes[0]!.tags);
  assert.ok(backlotChanges(next, productionSnapshot(script())).scenes[0]!.kinds.includes("tags"));
  omitScene(doc, "s1");
  const omitted = productionSnapshot(doc.toScript());
  assert.ok(backlotChanges(next, omitted).scenes[0]!.kinds.includes("omitted"));
  assert.ok(backlotChanges({ ...b, scenes: omitted.scenes }, tagged).scenes[0]!.kinds.includes("restored"));
});

test("baseline survives document reopen and malformed metadata is ignored", () => {
  const doc = new ScreenplayDoc(); doc.load(script());
  const b = baseline(); doc.meta.set(BACKLOT_BASELINE, b);
  const reopened = ScreenplayDoc.fromUpdate(doc.encodeState());
  assert.deepEqual(backlotBaseline(reopened.meta.get(BACKLOT_BASELINE)), b);
  assert.equal(backlotBaseline({ version: 1, scenes: [null], sentAt: "x", projectId: "x" }), null);
  assert.equal(isProductionSnapshot({ version: 1, scenes: [b.scenes[0], b.scenes[0]] }), false);
  assert.equal(backlotBaseline(null), null);
  assert.equal(backlotBaseline({ ...b, revision: -1 }), null);
  assert.equal(backlotBaseline({ ...b, revision: 1.5 }), null);
  assert.equal(backlotBaseline({ ...b, revision: "2" }), null);
  assert.deepEqual(backlotBaseline({ ...b, revision: 2 }), { ...b, revision: 2 });
});
