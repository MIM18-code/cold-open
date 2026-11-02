import { ELEMENT_TYPES } from "@screenplay/engine";
import assert from "node:assert/strict";
import { test } from "node:test";

import { DICTATION_TYPES, fromEngineType, parentheticalText, toEngineType } from "../src/shared/channels/dictation.ts";

test("every dictation element type maps to an engine type", () => {
  assert.deepEqual(DICTATION_TYPES.map(toEngineType), [
    "sceneHeading", "action", "character", "dialogue", "parenthetical", "transition", "shot", "note",
  ]);
  for (const type of DICTATION_TYPES) assert.ok((ELEMENT_TYPES as readonly string[]).includes(toEngineType(type)));
});

test("engine types the formatter has no word for read as action", () => {
  assert.equal(fromEngineType("sceneHeading"), "scene_heading");
  assert.equal(fromEngineType("dialogue"), "dialogue");
  assert.equal(fromEngineType("general"), "action");
  assert.equal(fromEngineType("lyrics"), "action");
});

test("the mapping round-trips for the types both sides share", () => {
  for (const type of DICTATION_TYPES) assert.equal(fromEngineType(toEngineType(type)), type);
});

test("parentheticals get their brackets once", () => {
  assert.equal(parentheticalText("whispering"), "(whispering)");
  assert.equal(parentheticalText("(whispering)"), "(whispering)");
  assert.equal(parentheticalText("  beat "), "(beat)");
});
