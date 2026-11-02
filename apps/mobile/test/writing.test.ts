import assert from "node:assert/strict";
import test from "node:test";
import { insertCue, replaceSelection } from "../src/writing.ts";
import { parseFountain } from "@screenplay/engine";

test("writing toolbar builds Fountain at the cursor with dialogue and parentheticals", () => {
  let state = insertCue("", { start: 0, end: 0 }, "Scene");
  state = replaceSelection(state.text, state.selection, "KITCHEN - DAY");
  state = insertCue(state.text, state.selection, "Character");
  state = replaceSelection(state.text, state.selection, "MARA");
  state = insertCue(state.text, state.selection, "Parenthetical");
  state = replaceSelection(state.text, state.selection, "quietly");
  assert.equal(state.text, "INT. KITCHEN - DAY\n\n@MARA\n(quietly)");
  state.selection = { start: state.text.length, end: state.text.length };
  state = replaceSelection(state.text, state.selection, "\nClose the door.");
  state = insertCue(state.text, state.selection, "Transition");
  assert.deepEqual(parseFountain(state.text).paragraphs.map(p => p.type),
    ["sceneHeading", "character", "parenthetical", "dialogue", "transition"]);
});

test("speech partials replace the captured selection without consuming text after the cursor", () => {
  const text = "Before. old After.", selection = { start: 8, end: 11 };
  assert.equal(replaceSelection(text, selection, "New").text, "Before. New After.");
  assert.deepEqual(replaceSelection(text, selection, "New words."), {
    text: "Before. New words. After.", selection: { start: 18, end: 18 },
  });
});
