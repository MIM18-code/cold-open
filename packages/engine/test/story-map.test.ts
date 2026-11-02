import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";

import {
  ScreenplayDoc, addStructurePoint, addStructurePointPreset, clampPosition, formatPointPage, pageDelta, pagePosition,
  lockPages, pageLocks, paginate, parsePointPosition, pointOffset, pointPage, removeStructurePoint, revisionState, setRevisionState,
  storyMap, structurePoints, updateStructurePoint, writeFdx, type Paragraph, type RevisionState,
} from "../src/index.ts";

test("a target is a share of the script, and pages map both ways", () => {
  assert.equal(clampPosition(-2), 0);
  assert.equal(clampPosition(2), 1);
  assert.equal(clampPosition(Number.NaN), 0);
  assert.equal(pointOffset(0.5, 100), 50);
  assert.equal(pointOffset(0, 100), 0);
  assert.equal(pointOffset(1, 100), 100);
  // Halfway through 100 pages is the top of page 51.
  assert.equal(pointPage(0.5, 100), 51);
  assert.equal(pointPage(0, 100), 1);
  assert.equal(pointPage(1, 100), 100);
  assert.equal(pointPage(0.5, 0), 1);
  assert.equal(pagePosition(51, 100), 0.5);
  assert.equal(pagePosition(1, 100), 0);
  assert.equal(pagePosition(100, 100), 0.99);
  assert.equal(pagePosition(1, 1), 0);
  // A scene that starts 50 pages in sits on a 50% target; four pages further on is four pages late.
  assert.equal(pageDelta(0.5, 50, 100), 0);
  assert.equal(pageDelta(0.5, 54, 100), 4);
  assert.equal(pageDelta(0.5, 46, 100), -4);
});

test("a target reads as a page or as a percentage", () => {
  assert.equal(parsePointPosition("50%", 100), 0.5);
  assert.equal(parsePointPosition("25 %", 100), 0.25);
  assert.equal(parsePointPosition("100%", 100), 1);
  assert.equal(parsePointPosition("200%", 100), 1);
  assert.equal(parsePointPosition("p. 51", 100), 0.5);
  assert.equal(parsePointPosition("page 26", 100), 0.25);
  assert.equal(parsePointPosition("51", 100), 0.5);
  assert.equal(parsePointPosition(" 51.5 ", 100), 0.505);
  assert.equal(parsePointPosition("1", 100), 0);
  assert.equal(parsePointPosition("0", 100), 0);
  assert.equal(parsePointPosition("", 100), undefined);
  assert.equal(parsePointPosition("halfway", 100), undefined);
  assert.equal(parsePointPosition("p.", 100), undefined);
  assert.equal(formatPointPage(51), "p. 51");
  assert.equal(formatPointPage(50.5), "p. 50.5");
});

function twoScenes(): ScreenplayDoc {
  const paragraphs: Paragraph[] = [{ id: "s1", type: "sceneHeading", sceneId: "s1", runs: [{ text: "INT. A - DAY" }] }];
  for (let i = 0; i < 45; i++) paragraphs.push({ id: `a1-${i}`, type: "action", runs: [{ text: `Action ${i} in the first scene, long enough to wrap onto a second line.` }] });
  paragraphs.push({ id: "s2", type: "sceneHeading", sceneId: "s2", runs: [{ text: "INT. B - NIGHT" }] });
  for (let i = 0; i < 45; i++) paragraphs.push({ id: `a2-${i}`, type: "action", runs: [{ text: `Action ${i} in the second scene, also long enough to wrap.` }] });
  const doc = new ScreenplayDoc();
  doc.load({ titlePage: [], paragraphs });
  return doc;
}

test("structure points use flat field keys and survive a save and reopen", () => {
  const doc = twoScenes();
  const midpoint = addStructurePoint(doc, { name: "  Midpoint  ", position: 0.5 });
  const catalyst = addStructurePoint(doc, { name: "Catalyst", position: 0.1, sceneId: "s1" });
  assert.equal(midpoint.name, "Midpoint");
  assert.deepEqual(structurePoints(doc).map((point) => point.name), ["Catalyst", "Midpoint"]);
  assert.equal(structurePoints(doc)[0]!.sceneId, "s1");
  assert.deepEqual([...doc.meta.keys()].filter((key) => key.startsWith(`structurePoint.${midpoint.id}.`)).sort(), [
    `structurePoint.${midpoint.id}.name`, `structurePoint.${midpoint.id}.position`,
  ]);
  assert.equal(doc.meta.get(`structurePoint.${catalyst.id}.name`), "Catalyst");
  assert.equal(doc.meta.get(`structurePoint.${catalyst.id}.position`), 0.1);
  assert.equal(doc.meta.get(`structurePoint.${catalyst.id}.sceneId`), "s1");

  updateStructurePoint(doc, midpoint.id, { position: 0.55, sceneId: "s2" });
  assert.deepEqual(structurePoints(doc).find((point) => point.id === midpoint.id), {
    id: midpoint.id, name: "Midpoint", position: 0.55, sceneId: "s2",
  });
  // A cleared name becomes a named-but-untitled point, so the field and the marker always have something to show.
  updateStructurePoint(doc, midpoint.id, { name: "   ", position: 3 });
  assert.equal(structurePoints(doc).find((point) => point.id === midpoint.id)!.name, "Untitled point");
  assert.equal(structurePoints(doc).find((point) => point.id === midpoint.id)!.position, 1);
  updateStructurePoint(doc, midpoint.id, { sceneId: null });
  assert.equal(structurePoints(doc).find((point) => point.id === midpoint.id)!.sceneId, undefined);
  assert.equal(doc.meta.has(`structurePoint.${midpoint.id}.sceneId`), false);

  // A reopened document, as a saved .screenplay file carries it, has the same points.
  const reopened = ScreenplayDoc.fromUpdate(doc.encodeState());
  assert.deepEqual(structurePoints(reopened), structurePoints(doc));

  assert.equal(removeStructurePoint(doc, catalyst.id), true);
  assert.equal([...doc.meta.keys()].some((key) => key.startsWith(`structurePoint.${catalyst.id}.`)), false);
  assert.equal(removeStructurePoint(doc, catalyst.id), false);
  assert.deepEqual(structurePoints(doc).map((point) => point.id), [midpoint.id]);
  assert.throws(() => updateStructurePoint(doc, catalyst.id, { position: 0.2 }), RangeError);
});

test("points from two writers merge independently", () => {
  const first = twoScenes();
  const second = ScreenplayDoc.fromUpdate(first.encodeState());
  const a = addStructurePoint(first, { name: "Inciting Incident", position: 0.1 });
  const b = addStructurePoint(second, { name: "Midpoint", position: 0.5 });
  Y.applyUpdate(first.ydoc, Y.encodeStateAsUpdate(second.ydoc));
  Y.applyUpdate(second.ydoc, Y.encodeStateAsUpdate(first.ydoc));
  assert.deepEqual(structurePoints(first).map((point) => point.name), ["Inciting Incident", "Midpoint"]);
  assert.deepEqual(structurePoints(second), structurePoints(first));
  // Each writer can move their own point without overwriting the other.
  updateStructurePoint(first, a.id, { position: 0.15 });
  updateStructurePoint(second, b.id, { position: 0.55 });
  Y.applyUpdate(first.ydoc, Y.encodeStateAsUpdate(second.ydoc));
  Y.applyUpdate(second.ydoc, Y.encodeStateAsUpdate(first.ydoc));
  assert.deepEqual(structurePoints(first).map((point) => point.position), [0.15, 0.55]);
  assert.deepEqual(structurePoints(second), structurePoints(first));
});

test("malformed fields and orphan fields are ignored instead of breaking the view", () => {
  const doc = twoScenes();
  doc.meta.set("structurePoint.bad.name", "   ");
  doc.meta.set("structurePoint.bad.position", 0.5);
  doc.meta.set("structurePoint.nan.name", "No position");
  doc.meta.set("structurePoint.nan.position", Number.NaN);
  doc.meta.set("structurePoint.nan.sceneId", 7);
  doc.meta.set("structurePoint.text.name", 7);
  doc.meta.set("structurePoint.orphan.position", 0.5);
  doc.meta.set("structurePoint.orphan.sceneId", "s1");
  doc.meta.set("structurePoint..name", "No ID");
  const points = structurePoints(doc);
  assert.deepEqual(points.map((point) => point.name), ["No position"]);
  assert.equal(points[0]!.position, 0);
  assert.equal(points[0]!.sceneId, undefined);
});

test("presets add their points once and keep custom points", () => {
  const doc = twoScenes();
  const added = addStructurePointPreset(doc, "threeAct");
  assert.equal(added.length, 5);
  assert.deepEqual(added.map((point) => point.name), ["Inciting Incident", "First Act Turn", "Midpoint", "Second Act Turn", "Climax"]);
  const custom = addStructurePoint(doc, { name: "midpoint", position: 0.4 });
  assert.equal(addStructurePointPreset(doc, "beatSheet").length, 7);
  assert.equal(structurePoints(doc).filter((point) => point.name.toLowerCase() === "midpoint").length, 2);
  assert.equal(addStructurePointPreset(doc, "threeAct").length, 0);
  assert.throws(() => addStructurePointPreset(doc, "nope"), RangeError);
  // The custom point stays where the writer put it.
  assert.equal(structurePoints(doc).find((point) => point.id === custom.id)!.position, 0.4);
});

test("points are not written to Final Draft files", () => {
  const doc = twoScenes();
  addStructurePoint(doc, { name: "The Midpoint Beat", position: 0.5 });
  const xml = writeFdx(doc.toScript());
  assert.ok(!xml.includes("The Midpoint Beat"));
});

test("the story map tiles the script in pages, in scene order", () => {
  const doc = twoScenes();
  const script = doc.toScript();
  const pagination = paginate(script);
  assert.ok(pagination.pages.length >= 2);
  const map = storyMap(script, pagination);
  assert.equal(map.pages, pagination.pages.length);
  assert.equal(map.scenes.length, 2);
  assert.equal(map.scenes[0]!.start, 0);
  assert.equal(map.scenes[0]!.page, "1");
  assert.ok(map.scenes[1]!.start > 0);
  const last = map.scenes.at(-1)!;
  assert.ok(Math.abs(last.start + last.length - map.pages) < 1e-9);
  assert.ok(Math.abs(map.scenes.reduce((total, scene) => total + scene.length, 0) - map.pages) < 1e-9);
});

test("a scene block carries its scene color and the revision on its pages", () => {
  const doc = twoScenes();
  doc.formatRuns("a2-0", 0, 6, { "fdx:RevisionID": "1" });
  const state: RevisionState = {
    sets: [{ id: "1", name: "Blue Rev.", color: "#C6EDFE", mark: "*", date: "", style: "" }],
    currentSetId: "1", tracking: false, showMarks: true,
  };
  setRevisionState(doc, state);
  const script = doc.toScript();
  const map = storyMap(script, paginate(script), revisionState(doc));
  assert.equal(map.scenes[0]!.revision, undefined);
  assert.equal(map.scenes[1]!.revision?.id, "1");
  assert.equal(map.scenes[1]!.revision?.color, "#C6EDFE");
});

test("an empty script has no scenes, still one blank page", () => {
  const doc = new ScreenplayDoc();
  doc.load({ titlePage: [], paragraphs: [] });
  const script = doc.toScript();
  assert.deepEqual(storyMap(script, paginate(script)), { pages: 1, pageLabels: ["1"], scenes: [] });
});

function syncPeers(first: ScreenplayDoc, second: ScreenplayDoc): void {
  const firstUpdate = first.encodeState();
  const secondUpdate = second.encodeState();
  Y.applyUpdate(first.ydoc, secondUpdate);
  Y.applyUpdate(second.ydoc, firstUpdate);
}

for (const patch of [{ name: "Renamed" }, { sceneId: "s2" }, { sceneId: null }]) {
  test(`concurrent movement preserves a point's ${JSON.stringify(patch)}`, () => {
    const first = twoScenes();
    const point = addStructurePoint(first, { name: "Midpoint", position: 0.5, sceneId: "s1" });
    const second = ScreenplayDoc.fromUpdate(first.encodeState());
    updateStructurePoint(first, point.id, patch);
    updateStructurePoint(second, point.id, { position: 0.6 });
    syncPeers(first, second);
    const expected = { ...point, position: 0.6, ...(patch.name ? { name: patch.name } : {}) };
    if (patch.sceneId === null) delete expected.sceneId;
    else if (patch.sceneId) expected.sceneId = patch.sceneId;
    assert.deepEqual(structurePoints(first), [expected]);
    assert.deepEqual(structurePoints(second), [expected]);
  });
}

test("deleting a point wins over a concurrent move on either peer", () => {
  for (const deleteOnFirst of [true, false]) {
    const first = twoScenes();
    const point = addStructurePoint(first, { name: "Midpoint", sceneId: "s1" });
    const second = ScreenplayDoc.fromUpdate(first.encodeState());
    removeStructurePoint(deleteOnFirst ? first : second, point.id);
    updateStructurePoint(deleteOnFirst ? second : first, point.id, { position: 0.7 });
    syncPeers(first, second);
    assert.deepEqual(structurePoints(first), []);
    assert.deepEqual(structurePoints(second), []);
    for (const peer of [first, second]) {
      assert.equal(peer.meta.has(`structurePoint.${point.id}.name`), false);
      assert.equal(peer.meta.has(`structurePoint.${point.id}.sceneId`), false);
      assert.equal(peer.meta.get(`structurePoint.${point.id}.position`), 0.7);
      assert.throws(() => updateStructurePoint(peer, point.id, { position: 0.8 }), RangeError);
      const reopened = ScreenplayDoc.fromUpdate(peer.encodeState());
      assert.deepEqual(structurePoints(reopened), []);
    }
  }
});

test("concurrent preset applications converge and preserve custom points", () => {
  for (const preset of ["threeAct", "beatSheet"]) {
    const first = twoScenes();
    const custom = addStructurePoint(first, { name: "Custom beat", position: 0.33 });
    const second = ScreenplayDoc.fromUpdate(first.encodeState());
    const added = addStructurePointPreset(first, preset);
    addStructurePointPreset(second, preset);
    syncPeers(first, second);
    assert.equal(structurePoints(first).length, added.length + 1);
    assert.deepEqual(structurePoints(first), structurePoints(second));
    assert.deepEqual(structurePoints(first).find((point) => point.id === custom.id), custom);
    updateStructurePoint(first, added[0]!.id, { name: "Renamed preset point" });
    assert.equal(addStructurePointPreset(first, preset).length, 0);
  }
});

// Each field is its own last-writer-wins key. An edit made after the peers sync always survives; an edit made on a
// disconnected copy that also applied the same preset races that copy's preset defaults, the same rule as any two
// concurrent edits to one field. Either way both peers converge on the same single point.
for (const preset of ["threeAct", "beatSheet"]) {
  test(`concurrent ${preset} applications converge on one Midpoint, and edits after sync are kept`, () => {
    const first = twoScenes();
    const second = ScreenplayDoc.fromUpdate(first.encodeState());
    first.ydoc.clientID = 1;
    second.ydoc.clientID = 2;
    addStructurePointPreset(first, preset);
    addStructurePointPreset(second, preset);
    updateStructurePoint(first, "beat-midpoint", { name: "The reveal" });
    updateStructurePoint(second, "beat-midpoint", { position: 0.6 });
    syncPeers(first, second);
    assert.deepEqual(structurePoints(first), structurePoints(second));
    assert.equal(structurePoints(first).filter((point) => point.id === "beat-midpoint").length, 1);
    // After sync, one writer renames and the other moves: both edits land.
    updateStructurePoint(first, "beat-midpoint", { name: "The reveal" });
    updateStructurePoint(second, "beat-midpoint", { position: 0.6 });
    syncPeers(first, second);
    for (const peer of [first, second]) {
      assert.deepEqual(structurePoints(peer).find((point) => point.id === "beat-midpoint"), {
        id: "beat-midpoint", name: "The reveal", position: 0.6,
      });
    }
  });
}

test("different concurrent presets share the canonical Midpoint ID", () => {
  const first = twoScenes();
  const second = ScreenplayDoc.fromUpdate(first.encodeState());
  const threeAct = addStructurePointPreset(first, "threeAct");
  const beatSheet = addStructurePointPreset(second, "beatSheet");
  assert.equal(threeAct.find((point) => point.name === "Midpoint")!.id, "beat-midpoint");
  assert.equal(beatSheet.find((point) => point.name === "Midpoint")!.id, "beat-midpoint");
  syncPeers(first, second);
  assert.deepEqual(structurePoints(first), structurePoints(second));
  assert.equal(structurePoints(first).length, threeAct.length + beatSheet.length - 1);
  assert.equal(structurePoints(first).filter((point) => point.name === "Midpoint").length, 1);
});

test("locked page labels drive scene references and targets without changing physical offsets", () => {
  const doc = new ScreenplayDoc();
  doc.load({ titlePage: [], paragraphs: [1, 2, 3, 4].map((page) => ({
    id: `s${page}`, sceneId: `s${page}`, type: "sceneHeading", startsNewPage: true,
    runs: [{ text: `INT. ROOM ${page} - DAY` }],
  })) });
  const pagination = paginate(doc.toScript());
  const labels = ["1", "2", "2A", "3"];
  assert.equal(pagination.pages.length, labels.length);
  pagination.pages.forEach((page, index) => { page.number = labels[index]!; });
  lockPages(doc, pagination);
  const locked = paginate(doc.toScript(), { locks: pageLocks(doc)! });
  assert.deepEqual(locked.pages.map((page) => page.number), labels);
  const map = storyMap(doc.toScript(), locked);
  assert.deepEqual(map.scenes.map((scene) => scene.page), labels);
  assert.deepEqual(map.scenes.map((scene) => scene.start), [0, 1, 2, 3]);
  assert.equal(parsePointPosition("2A", 4, labels), 0.5);
  assert.equal(parsePointPosition("p. 2a", 4, labels), 0.5);
  assert.equal(parsePointPosition("page 3", 4, labels), 0.75);
  assert.equal(parsePointPosition("2A.5", 4, labels), 0.625);
  assert.equal(parsePointPosition("4", 4, labels), undefined);
  assert.equal(parsePointPosition("2B", 4, labels), undefined);
  assert.equal(parsePointPosition("50%", 4, labels), 0.5);
  assert.equal(formatPointPage(pointPage(0.5, 4, labels)), "p. 2A");
  assert.equal(formatPointPage(pointPage(0.75, 4, labels)), "p. 3");
  assert.equal(formatPointPage(pointPage(1, 4, labels)), "p. 3");
});


test("unreleased record formats are ignored without migration", () => {
  const doc = twoScenes();
  const key = "structurePoint.old";
  doc.meta.set(key, { id: "old", name: "Midpoint", position: 0.5, sceneId: "s2" });
  const fields = new Y.Map<unknown>();
  fields.set("name", "Nested point");
  fields.set("position", 0.5);
  doc.meta.set("structurePoint.nested", fields);
  assert.deepEqual(structurePoints(doc), []);
  assert.throws(() => updateStructurePoint(doc, "old", { name: "Renamed" }), RangeError);
  assert.throws(() => updateStructurePoint(doc, "nested", { name: "Renamed" }), RangeError);
});
