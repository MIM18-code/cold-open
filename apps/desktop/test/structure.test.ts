import assert from "node:assert/strict";
import { test } from "node:test";

import { ScreenplayDoc, moveScenes, moveSection, parseFountain, plainText } from "@screenplay/engine";

import { dropAnchor, flattenOutline, structureOf, type Edge, type ItemRef } from "../src/renderer/features/navigator/structure-model.ts";

const SCRIPT = `INT. COLD OPEN - NIGHT

Wind.

# ACT ONE

= Setup.

INT. OFFICE - DAY

= Nell waits.

NELL
Well?

EXT. YARD - NIGHT

Rain.

# ACT TWO

INT. DINER - DAY

Coffee.
`;

const make = () => ScreenplayDoc.fromScript(parseFountain(SCRIPT));
const headings = (doc: ScreenplayDoc) => doc.scenes().map((s) => s.heading);
const scene = (id: string): ItemRef => ({ kind: "scene", id });
const section = (doc: ScreenplayDoc, title: string): ItemRef => ({
  kind: "section", id: doc.toScript().paragraphs.find((p) => plainText(p.runs) === title)!.id,
});

/** What the views do on a drop, minus the app. */
function drop(doc: ScreenplayDoc, source: ItemRef, target: ItemRef, edge: Edge): void {
  const before = dropAnchor(doc.toScript(), source, target, edge);
  if (source.kind === "scene") moveScenes(doc, [source.id], before);
  else moveSection(doc, source.id, before);
}

test("structureOf gathers summaries, the outline and each paragraph's scene", () => {
  const doc = make();
  const structure = structureOf(doc.toScript());
  assert.equal(structure.summaries.length, 4);
  assert.equal(structure.scenes.get(structure.summaries[1]!.sceneId)!.synopsis, "Nell waits.");
  const office = doc.scenes()[1]!;
  for (const id of office.paragraphIds.slice(0, 4)) assert.equal(structure.sceneOfParagraph(id), office.sceneId);
  // The ACT TWO title belongs to no scene, so moving a scene never drags it along.
  assert.equal(structure.sceneOfParagraph(section(doc, "ACT TWO").id), undefined);
});

test("the structure is computed once per script object", () => {
  const script = make().toScript();
  assert.equal(structureOf(script), structureOf(script));
});

test("flattenOutline lists sections and scenes in reading order with levels", () => {
  const items = flattenOutline(structureOf(make().toScript()).outline);
  assert.deepEqual(items.map((i) => [i.kind, i.level]), [
    ["scene", 0], ["section", 0], ["scene", 1], ["scene", 1], ["section", 0], ["scene", 1],
  ]);
});

test("dropping a scene on the edges of scenes and sections", () => {
  const doc = make();
  const [, office, yard, diner] = doc.scenes();

  // After Yard, the last scene of Act One, lands before the ACT TWO title.
  drop(doc, scene(office!.sceneId), scene(yard!.sceneId), "after");
  assert.deepEqual(headings(doc), ["INT. COLD OPEN - NIGHT", "EXT. YARD - NIGHT", "INT. OFFICE - DAY", "INT. DINER - DAY"]);
  assert.ok(doc.indexOf(office!.headingId) < doc.indexOf(section(doc, "ACT TWO").id));

  // The lower half of ACT TWO puts a scene first inside it, after the title.
  drop(doc, scene(yard!.sceneId), section(doc, "ACT TWO"), "after");
  assert.deepEqual(headings(doc), ["INT. COLD OPEN - NIGHT", "INT. OFFICE - DAY", "EXT. YARD - NIGHT", "INT. DINER - DAY"]);
  assert.ok(doc.indexOf(yard!.headingId) > doc.indexOf(section(doc, "ACT TWO").id));
  assert.ok(doc.indexOf(yard!.headingId) < doc.indexOf(diner!.headingId));

  // The upper half of ACT ONE puts a scene ahead of the title, out of the act.
  drop(doc, scene(diner!.sceneId), section(doc, "ACT ONE"), "before");
  assert.deepEqual(headings(doc), ["INT. COLD OPEN - NIGHT", "INT. DINER - DAY", "INT. OFFICE - DAY", "EXT. YARD - NIGHT"]);
  assert.ok(doc.indexOf(diner!.headingId) < doc.indexOf(section(doc, "ACT ONE").id));
  assert.deepEqual(doc.validate(), []);
});

test("dropping a section moves it with its scenes", () => {
  const doc = make();
  drop(doc, section(doc, "ACT TWO"), section(doc, "ACT ONE"), "before");
  assert.deepEqual(headings(doc), ["INT. COLD OPEN - NIGHT", "INT. DINER - DAY", "INT. OFFICE - DAY", "EXT. YARD - NIGHT"]);
  // After ACT ONE means after all of its scenes, which is back where it started.
  drop(doc, section(doc, "ACT TWO"), section(doc, "ACT ONE"), "after");
  assert.deepEqual(headings(doc), ["INT. COLD OPEN - NIGHT", "INT. OFFICE - DAY", "EXT. YARD - NIGHT", "INT. DINER - DAY"]);
});
