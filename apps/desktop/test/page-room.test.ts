import assert from "node:assert/strict";
import test from "node:test";
import { fitPageZoom, needsSceneCollapse, readablePageRoom } from "../src/renderer/shell/page-room.ts";

test("Fit width stops shrinking at 67 percent even with both sidebars forced open", () => {
  assert.equal(fitPageZoom(900 - 240 - 306 - 48, 8.5), 0.67);
  assert.equal(fitPageZoom(0, 8.5), 0.67);
  assert.equal(fitPageZoom(832, 8.5), 1);
  assert.equal(fitPageZoom(3000, 8.5), 2);
});

test("collapse threshold uses the document's paper width and actual editor gutters", () => {
  const letter = readablePageRoom(8.5, 48);
  assert.equal(letter, 8.5 * 96 * 0.67 + 64);
  assert(needsSceneCollapse(900, 240, 306, letter));
  assert(!needsSceneCollapse(1280, 240, 332, letter));
  assert(!needsSceneCollapse(572 + letter, 240, 332, letter));
  assert(needsSceneCollapse(571 + letter, 240, 332, letter));
  assert(!needsSceneCollapse(900, 240, 306, 0));
  assert(readablePageRoom(11.7, 48) > letter);
  assert.equal(readablePageRoom(8.5, 24), letter - 24);
});


test("a letter page fits 900px with the default right sidebar and visible scrollbars", () => {
  const sidebar = Math.min(332, 900 * 0.34);
  const gutters = 16;
  const scrollbar = 10;
  const available = 900 - sidebar - scrollbar;
  const scale = fitPageZoom(available - gutters, 8.5);
  assert(scale >= 0.67);
  assert(8.5 * 96 * scale + gutters <= available);
  assert(readablePageRoom(8.5, gutters) <= available);
  assert(needsSceneCollapse(900 - scrollbar, 240, sidebar, readablePageRoom(8.5, gutters)));
});
