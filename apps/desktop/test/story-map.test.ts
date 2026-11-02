import assert from "node:assert/strict";
import { test } from "node:test";

import { ScreenplayDoc, addStructurePoint, plainText } from "@screenplay/engine";

import { nativeOnlyFeatures } from "../src/renderer/features/file/preflight.ts";

test("structure points are named before a Final Draft or Fountain save", () => {
  const doc = new ScreenplayDoc();
  doc.load({ titlePage: [], paragraphs: [{ id: "s1", type: "sceneHeading", sceneId: "s1", runs: [{ text: "INT. ROOM - DAY" }] }] });
  assert.deepEqual(nativeOnlyFeatures(doc), []);
  addStructurePoint(doc, { name: "Midpoint", position: 0.5 });
  assert.deepEqual(nativeOnlyFeatures(doc), ["Structure points"]);
  // A point is metadata, never screenplay text.
  assert.deepEqual(doc.toScript().paragraphs.map((paragraph) => plainText(paragraph.runs)), ["INT. ROOM - DAY"]);
});

test("a stray field left by a deleted point does not trigger the export warning", () => {
  const doc = new ScreenplayDoc();
  doc.load({ titlePage: [], paragraphs: [{ id: "s1", type: "sceneHeading", sceneId: "s1", runs: [{ text: "INT. ROOM - DAY" }] }] });
  // What a delete merged with a concurrent move leaves: a position with no name.
  doc.ydoc.transact(() => doc.meta.set("structurePoint.orphan.position", 0.4));
  assert.deepEqual(nativeOnlyFeatures(doc), []);
});
