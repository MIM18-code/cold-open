// The editor's pure logic: Final Draft's element rules, SmartType, dual dialogue, find, the clipboard,
// and the ProseMirror drawing of engine paragraphs.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ScreenplayDoc, parseFountain, plainText, type Paragraph } from "@screenplay/engine";

import { clipboardText, readClipboard, selectedParagraphs, clipboardJson } from "../src/renderer/features/editor/clipboard.ts";
import {
  DEFAULT_NEXT, EMPTY_ENTER, characterNames, enterContext, dualDialogueChanges, findMatches, nextElement, parentheticalInput, sceneLocations,
  repairMessage, suggestions, tabAction, typedText, unwrapParenthetical, wrapParenthetical,
} from "../src/renderer/features/editor/rules.ts";
import { bodyIndexOf, buildDoc, paragraphPositions, sameDisplay, schema, tokensBetween } from "../src/renderer/features/editor/schema.ts";

const SCRIPT = parseFountain(`INT. KITCHEN - NIGHT

Mara opens the fridge.

MARA
Nothing.

JONAH (O.S.)
Check the door.

EXT. ROOF - DAY

MARA
(quietly)
Up here.

JONAH
Coming.
`).paragraphs;

test("Enter starts the next element, and empty elements change instead", () => {
  assert.equal(nextElement("sceneHeading"), "action");
  assert.equal(nextElement("character"), "dialogue");
  assert.equal(nextElement("parenthetical"), "dialogue");
  assert.equal(nextElement("dialogue"), "action");
  assert.equal(nextElement("transition"), "sceneHeading");
  assert.equal(nextElement("shot"), "action");
  assert.equal(nextElement("dialogue", { dialogue: "character" }), "character", "the setting overrides a default");
  assert.equal(EMPTY_ENTER.character, "action");
  assert.equal(EMPTY_ENTER.dialogue, "action");
  assert.equal(EMPTY_ENTER.action, undefined);
  assert.equal(Object.keys(DEFAULT_NEXT).length, 15);
});

test("Enter reads a parenthetical's parentheses as part of the element", () => {
  assert.deepEqual(enterContext("parenthetical", "(beat)", 5), { empty: false, atEnd: true }, "before the closing parenthesis is the end");
  assert.deepEqual(enterContext("parenthetical", "(beat)", 6), { empty: false, atEnd: true });
  assert.deepEqual(enterContext("parenthetical", "(beat)", 3), { empty: false, atEnd: false });
  assert.deepEqual(enterContext("parenthetical", "()", 1), { empty: true, atEnd: true });
  assert.deepEqual(enterContext("parenthetical", "", 0), { empty: true, atEnd: true });
  assert.deepEqual(enterContext("action", "Run.", 3), { empty: false, atEnd: false });
  assert.deepEqual(enterContext("action", "", 0), { empty: true, atEnd: true });
  assert.equal(EMPTY_ENTER.parenthetical, "dialogue");
});

test("Tab and Shift-Tab follow Final Draft", () => {
  assert.deepEqual(tabAction("action", true, false), { kind: "setType", type: "character" });
  assert.deepEqual(tabAction("character", true, false), { kind: "setType", type: "transition" });
  assert.deepEqual(tabAction("character", true, true), { kind: "setType", type: "action" });
  assert.deepEqual(tabAction("sceneHeading", true, false), { kind: "setType", type: "action" });
  assert.deepEqual(tabAction("dialogue", false, false), { kind: "parenthetical" });
  assert.deepEqual(tabAction("dialogue", true, false), { kind: "parenthetical" });
  assert.deepEqual(tabAction("parenthetical", false, false), { kind: "dialogue" });
  assert.equal(tabAction("action", false, false), null, "Tab does nothing in an action line with text");
  assert.equal(tabAction("general", false, true), null);
});

test("caps elements store uppercase and parentheticals keep their parentheses", () => {
  assert.equal(typedText("character", "mara"), "MARA");
  assert.equal(typedText("sceneHeading", "int. "), "INT. ");
  assert.equal(typedText("transition", "cut to:"), "CUT TO:");
  assert.equal(typedText("action", "mara"), "mara");
  assert.deepEqual(parentheticalInput("", 0, "b"), { insert: "(b)", at: 0, caret: 2 });
  assert.deepEqual(parentheticalInput("", 0, "("), { insert: "()", at: 0, caret: 1 });
  assert.deepEqual(parentheticalInput("(beat)", 5, ")"), { insert: "", at: 5, caret: 6 });
  assert.equal(parentheticalInput("(be)", 3, "a"), null);
  assert.equal(wrapParenthetical("beat"), "(beat)");
  assert.equal(wrapParenthetical("(beat)"), "(beat)");
  assert.equal(unwrapParenthetical("(beat)"), "beat");
});

test("SmartType offers names, scene prefixes, locations, times and transitions", () => {
  assert.deepEqual(characterNames(SCRIPT), ["JONAH", "MARA"]);
  assert.deepEqual(sceneLocations(SCRIPT), ["KITCHEN", "ROOF"]);
  assert.deepEqual(suggestions("character", "MA", 2, SCRIPT), { from: 0, to: 2, items: ["MARA"] });
  assert.equal(suggestions("character", "MARA", 4, SCRIPT), null, "an exact name needs no suggestion");
  assert.equal(suggestions("character", "MA", 1, SCRIPT), null, "only at the end of the paragraph");
  assert.deepEqual(suggestions("character", "MARA (V", 7, SCRIPT), { from: 5, to: 7, items: ["(V.O.)"] });
  assert.deepEqual(suggestions("sceneHeading", "E", 1, SCRIPT), { from: 0, to: 1, items: ["EXT. "] });
  assert.deepEqual(suggestions("sceneHeading", "I", 1, SCRIPT)!.items, ["INT. ", "INT./EXT. ", "I/E "]);
  assert.deepEqual(suggestions("sceneHeading", "INT. K", 6, SCRIPT), { from: 5, to: 6, items: ["KITCHEN - "] });
  assert.deepEqual(suggestions("sceneHeading", "INT. HALL - ", 12, SCRIPT)!.items.slice(0, 3), ["DAY", "NIGHT", "CONTINUOUS"]);
  assert.deepEqual(suggestions("sceneHeading", "INT. HALL - MO", 14, SCRIPT), { from: 12, to: 14, items: ["MORNING", "MOMENTS LATER"] });
  assert.deepEqual(suggestions("transition", "SM", 2, SCRIPT), { from: 0, to: 2, items: ["SMASH CUT TO:"] });
  assert.equal(suggestions("action", "MA", 2, SCRIPT), null);
});

test("Make Dual Dialogue pairs neighbouring speeches and turns a pair back off", () => {
  const paragraphs = SCRIPT;
  // Caret in MARA's "Nothing." pairs it with JONAH's speech after it.
  const changes = dualDialogueChanges(paragraphs, 3, 3)!;
  assert.deepEqual(changes.map((c) => plainText(paragraphs.find((p) => p.id === c.id)!.runs)), ["MARA", "Nothing.", "JONAH (O.S.)", "Check the door."]);
  assert.deepEqual(changes.map((c) => c.dual!.side), [1, 1, 2, 2]);
  assert.equal(new Set(changes.map((c) => c.dual!.block)).size, 1);
  // Caret in the second speech of a pair pairs it with the one before.
  const last = paragraphs.length - 1;
  const back = dualDialogueChanges(paragraphs, last, last)!;
  assert.deepEqual(back.map((c) => c.dual!.side), [1, 1, 1, 2, 2]);
  // Inside a dual block it turns the block off.
  const dual: Paragraph[] = paragraphs.map((p) => {
    const change = changes.find((c) => c.id === p.id);
    return change ? { ...p, dual: change.dual! } : p;
  });
  assert.deepEqual(dualDialogueChanges(dual, 4, 4)!.map((c) => c.dual), [undefined, undefined, undefined, undefined]);
  assert.equal(dualDialogueChanges(paragraphs, 1, 1), null, "action is not dialogue");
});

test("find honours match case and whole word", () => {
  const paragraphs: Paragraph[] = [
    { id: "a", type: "action", runs: [{ text: "Mara and MARA and Marathon." }] },
    { id: "b", type: "dialogue", runs: [{ text: "mara?" }] },
  ];
  assert.equal(findMatches(paragraphs, "mara", { matchCase: false, wholeWord: false }).length, 4);
  assert.equal(findMatches(paragraphs, "mara", { matchCase: false, wholeWord: true }).length, 3);
  assert.deepEqual(findMatches(paragraphs, "Mara", { matchCase: true, wholeWord: true }), [{ paragraphId: "a", from: 0, to: 4 }]);
  assert.equal(findMatches(paragraphs, "(", { matchCase: false, wholeWord: false }).length, 0, "the query is literal text");
});

test("copy writes Fountain and JSON; paste reads either back", () => {
  const [heading, action, cue, line] = SCRIPT;
  const selected = selectedParagraphs(SCRIPT, { paragraphId: action!.id, offset: 5 }, { paragraphId: line!.id, offset: 4 });
  assert.deepEqual(selected.map((p) => plainText(p.runs)), ["opens the fridge.", "MARA", "Noth"]);
  assert.equal(clipboardText(selected.slice(0, 1)), "opens the fridge.");
  assert.equal(clipboardText(selected), "opens the fridge.\n\nMARA\nNoth\n");
  const fromJson = readClipboard(clipboardJson(selected), "ignored");
  assert.ok(fromJson && "paragraphs" in fromJson);
  assert.deepEqual(fromJson.paragraphs.map((p) => p.type), ["action", "character", "dialogue"]);
  assert.deepEqual(readClipboard(clipboardJson([heading!]), undefined), { runs: heading!.runs });
  assert.deepEqual(readClipboard(undefined, "just a line\n"), { runs: [{ text: "just a line" }] });
  const fountain = readClipboard(undefined, "EXT. ALLEY - NIGHT\r\n\r\nRain.\r\n\r\nCOP\r\nFreeze!\r\n");
  assert.ok(fountain && "paragraphs" in fountain);
  assert.deepEqual(fountain.paragraphs.map((p) => [p.type, plainText(p.runs)]), [["sceneHeading", "EXT. ALLEY - NIGHT"], ["action", "Rain."], ["character", "COP"], ["dialogue", "Freeze!"]]);
  assert.equal(readClipboard("{not json", undefined), null);
  // JSON under our type can come from any app: malformed paragraphs and runs are dropped, not inserted.
  const odd = JSON.stringify({ paragraphs: [
    { type: "action", runs: [{ text: 5 }, { text: "Kept." }] }, { type: "bogus", runs: [{ text: "x" }] }, null,
    { type: "dialogue", runs: [{ text: "Yes." }], dual: { block: 3, side: 9 } },
  ] });
  const cleaned = readClipboard(odd, undefined);
  assert.ok(cleaned && "paragraphs" in cleaned);
  assert.deepEqual(cleaned.paragraphs.map((p) => [p.type, plainText(p.runs), p.dual]), [["action", "Kept.", undefined], ["dialogue", "Yes.", undefined]]);
  assert.deepEqual(readClipboard(JSON.stringify({ paragraphs: "no" }), "fallback"), { runs: [{ text: "fallback" }] });
  assert.ok(cue);
});

test("paste keeps Final Draft extras only from this window's own clipboard JSON", () => {
  const fdx = { attrs: [["Custom", "1"]] as [string, string][], after: [{ name: "Script", attrs: [], children: ["<evil/>"] }] };
  const paragraphs = [
    { id: "a", type: "action" as const, runs: [{ text: "One ", bold: true as const, fdx: { Font: "Courier" } }], fdx },
    { id: "b", type: "action" as const, runs: [{ text: "Two" }], fdx, sceneNumber: "9" },
  ];
  const own = readClipboard(clipboardJson(paragraphs), undefined);
  assert.ok(own && "paragraphs" in own);
  assert.deepEqual(own.paragraphs[0]!.fdx, fdx);
  assert.deepEqual(own.paragraphs[0]!.runs[0]!.fdx, { Font: "Courier" });

  // The same shape from another app or window: text and marks survive, FDX data and unknown fields do not.
  const foreign = readClipboard(JSON.stringify({ version: 1, source: "someone-else", paragraphs }), undefined);
  assert.ok(foreign && "paragraphs" in foreign);
  assert.deepEqual(foreign.paragraphs, [
    { id: "a", type: "action", runs: [{ text: "One ", bold: true }] },
    { id: "b", type: "action", runs: [{ text: "Two" }] },
  ]);
  const single = readClipboard(JSON.stringify({ paragraphs: [paragraphs[0]] }), undefined);
  assert.deepEqual(single, { runs: [{ text: "One ", bold: true }] });
});

test("the drawing groups dual dialogue into columns and maps positions to the engine body", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: SCRIPT });
  const paragraphs = doc.paragraphs().map((p, i) => (i === 2 || i === 3 ? { ...p, dual: { block: "d", side: 1 as const } } : i === 4 || i === 5 ? { ...p, dual: { block: "d", side: 2 as const } } : p));
  const pm = buildDoc(paragraphs);
  assert.equal(pm.childCount, paragraphs.length - 3);
  assert.equal(pm.child(2).type, schema.nodes.dual);
  assert.equal(pm.child(2).child(1).child(0).textContent, "JONAH (O.S.)");
  // Every paragraph's text start maps to the engine's body offset for it.
  const positions = paragraphPositions(pm);
  for (const paragraph of doc.paragraphs()) {
    assert.equal(bodyIndexOf(pm, positions.get(paragraph.id)! + 1), doc.bodyIndex({ paragraphId: paragraph.id, offset: 0 }));
  }
  const tokens = tokensBetween(pm, positions.get(paragraphs[1]!.id)! + 5, positions.get(paragraphs[2]!.id)! + 3);
  assert.deepEqual(tokens.map((t) => ("type" in t ? `[${t.type}]` : t.char)).join(""), " opens the fridge.[character]MA");
  assert.ok(sameDisplay(paragraphs[0]!, { ...paragraphs[0]!, fdx: { attrs: [] } }), "data that is not drawn does not count");
  assert.ok(!sameDisplay(paragraphs[1]!, { ...paragraphs[1]!, runs: [{ text: "Mara opens the fridge.", bold: true }] }));
});

test("the writer hears which scenes co-writers' moves left in the script twice", () => {
  assert.equal(repairMessage({ copies: ["y1-2", "y1-3"], headings: ["INT. OFFICE - DAY"], missing: 0 }),
    "Co-writers moved \"INT. OFFICE - DAY\" at the same time, so the script has two copies. Nothing was deleted: remove the copy you don't want.");
  assert.match(repairMessage({ copies: ["a", "b"], headings: ["INT. A - DAY", ""], missing: 0 })!, /moved 2 scenes \("INT. A - DAY", "an untitled scene"\)/);
  assert.match(repairMessage({ copies: ["a"], headings: [], missing: 0 })!, /some text in the script twice/);
  // An ID filled in on a line break that had none changes nothing the writer can see.
  assert.equal(repairMessage({ copies: [], headings: [], missing: 2 }), null);
});

test("paste drops tag references missing from the target while retaining known tags and run styles", () => {
  const source = [{ id: "p", type: "action" as const, runs: [
    { text: "Door", bold: true as const, fdx: { InklotTagId: "foreign", TagNumber: "1", Font: "Courier" } },
  ] }];
  const json = clipboardJson(source);
  const target = { titlePage: [], paragraphs: [] };
  assert.deepEqual(readClipboard(json, undefined, target), {
    runs: [{ text: "Door", bold: true, fdx: { Font: "Courier" } }],
  });
  const known = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: source });
  known.meta.set("fdx.tagDefinition.foreign", {
    id: "foreign", label: "Door", category: "Props", categoryId: "props", categoryNumber: 6,
  });
  assert.deepEqual(readClipboard(json, undefined, known.toScript()), { runs: source[0]!.runs });
  known.ydoc.destroy();
});
