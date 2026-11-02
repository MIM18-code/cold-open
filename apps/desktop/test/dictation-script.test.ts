// Context, edit commands and insertion against a real document session.
import { ScreenplayDoc, type ElementType, newId, plainText } from "@screenplay/engine";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { EditorBridge, NewParagraph, Position } from "../src/renderer/core/editor-bridge.ts";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { buildTakeContext, cueName, locationName } from "../src/renderer/features/dictation/context.ts";
import { applyMatches, findMatches, matchCase } from "../src/renderer/features/dictation/edits.ts";
import { insertElements } from "../src/renderer/features/dictation/insert.ts";

function sessionOf(rows: [ElementType, string][]): DocumentSession {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: rows.map(([type, text]) => ({ id: newId(), type, runs: text ? [{ text }] : [] })) });
  const session = new DocumentSession(doc);
  session.undo.clear();
  session.dirty = false;
  return session;
}

const SCRIPT: [ElementType, string][] = [
  ["sceneHeading", "INT. MAYA'S KITCHEN - NIGHT"],
  ["action", "MAYA (30s) stands at the sink. Tommy watches from the door."],
  ["character", "MAYA (V.O.)"],
  ["dialogue", "I can't do this anymore."],
  ["sceneHeading", "EXT. PARKING LOT - DAY"],
  ["action", "Bob waits by the car. Bobby does not."],
  ["character", "BOB"],
  ["dialogue", "Bob's not here."],
];

test("cue and location names are cleaned", () => {
  assert.equal(cueName("Maya (CONT'D)"), "MAYA");
  assert.equal(cueName("MAYA ^"), "MAYA");
  assert.equal(locationName("INT. MAYA'S KITCHEN - NIGHT"), "MAYA'S KITCHEN");
  assert.equal(locationName("EXT./INT. CAR - MOVING - DAY"), "CAR - MOVING");
  assert.equal(locationName("INT KITCHEN"), "KITCHEN");
});

test("the context is the current scene up to the caret, with cast and introductions", () => {
  const session = sessionOf(SCRIPT);
  const paragraphs = session.script().paragraphs;
  const context = buildTakeContext(session.script(), paragraphs[3]!.id);
  assert.deepEqual(context.characters, ["MAYA", "BOB"]);
  assert.deepEqual(context.locations, ["MAYA'S KITCHEN", "PARKING LOT"]);
  assert.equal(context.currentHeading, "INT. MAYA'S KITCHEN - NIGHT");
  assert.match(context.referenceText, /^INT\. MAYA'S KITCHEN - NIGHT\n/);
  assert.ok(!context.referenceText.includes("PARKING LOT"));
  assert.deepEqual(context.previousElements.map((e) => e.type), ["scene_heading", "action", "character", "dialogue"]);
  // MAYA has walked on; BOB has not appeared yet at this point in the script.
  assert.deepEqual(context.introduced, ["MAYA"]);
});

test("text after the caret offset is not shown", () => {
  const session = sessionOf(SCRIPT);
  const action = session.script().paragraphs[1]!;
  const context = buildTakeContext(session.script(), action.id, 20);
  assert.equal(context.referenceText.split("\n").at(-1), "MAYA (30s) stands at");
});

test("with no caret the take goes after the last paragraph", () => {
  const session = sessionOf(SCRIPT);
  const context = buildTakeContext(session.script(), null);
  assert.equal(context.currentHeading, "EXT. PARKING LOT - DAY");
  assert.deepEqual(context.introduced, ["MAYA", "BOB"]);
});

test("an empty script gives an empty context", () => {
  const context = buildTakeContext({ titlePage: [], paragraphs: [] }, null);
  assert.deepEqual(context.characters, []);
  assert.equal(context.referenceText, "");
});

test("a replacement takes the casing of what it replaces", () => {
  assert.equal(matchCase("BOB", "Robert"), "ROBERT");
  assert.equal(matchCase("Bob", "robert"), "Robert");
  assert.equal(matchCase("bob", "Robert"), "Robert");
  assert.equal(matchCase("I", "we"), "We");
});

test("matches are whole words, including possessives", () => {
  const session = sessionOf(SCRIPT);
  const matches = findMatches(session.script(), { find: "Bob", replacement: "Robert", scope: "script" });
  assert.deepEqual(matches.map((m) => m.matched), ["Bob", "BOB", "Bob"]);
  assert.deepEqual(matches.map((m) => m.replacement), ["Robert", "ROBERT", "Robert"]);
});

test("a scene-scoped command stays in the caret's scene", () => {
  const session = sessionOf(SCRIPT);
  const [heading, action] = session.script().paragraphs;
  assert.equal(findMatches(session.script(), { find: "Maya", replacement: "Mia", scope: "scene" }, action!.id).length, 3);
  assert.equal(findMatches(session.script(), { find: "Bob", replacement: "Robert", scope: "scene" }, heading!.id).length, 0);
});

test("accepting replaces every match in one undoable edit and keeps formatting", () => {
  const session = sessionOf(SCRIPT);
  const target = session.script().paragraphs[5]!;
  session.edit(() => session.doc.format(target.id, 0, 3, { bold: true }));
  session.undo.stopCapturing();
  const matches = findMatches(session.script(), { find: "Bob", replacement: "Robert", scope: "script" });
  assert.equal(applyMatches(session, matches), 3);
  const after = session.script().paragraphs;
  assert.equal(plainText(after[5]!.runs), "Robert waits by the car. Bobby does not.");
  assert.equal(plainText(after[6]!.runs), "ROBERT");
  assert.equal(plainText(after[7]!.runs), "Robert's not here.");
  assert.equal(after[5]!.runs[0]?.bold, true, "the bold on Bob carries to Robert");
  assert.equal(after[5]!.runs[0]?.text, "Robert");
  session.undo.undo();
  assert.equal(plainText(session.script().paragraphs[6]!.runs), "BOB");
  assert.equal(plainText(session.script().paragraphs[7]!.runs), "Bob's not here.");
});

test("two matches in one paragraph both change", () => {
  const session = sessionOf([["action", "Bob hugs Bob."]]);
  applyMatches(session, findMatches(session.script(), { find: "Bob", replacement: "Robert", scope: "script" }));
  assert.equal(plainText(session.script().paragraphs[0]!.runs), "Robert hugs Robert.");
});

const take = [
  { type: "sceneHeading" as const, text: "INT. KITCHEN - NIGHT", uncertainty: "" },
  { type: "action" as const, text: "Maya stands at the sink.", uncertainty: "" },
  { type: "character" as const, text: "MAYA", uncertainty: "" },
  { type: "dialogue" as const, text: "I can't do this anymore.", uncertainty: "" },
];

test("with no editor the take is appended, filling an empty last paragraph", () => {
  const session = sessionOf([["sceneHeading", ""]]);
  assert.equal(insertElements(session, null, take), 4);
  const paragraphs = session.script().paragraphs;
  assert.deepEqual(paragraphs.map((p) => p.type), ["sceneHeading", "action", "character", "dialogue"]);
  assert.equal(plainText(paragraphs[0]!.runs), "INT. KITCHEN - NIGHT");
  session.undo.undo();
  assert.equal(session.script().paragraphs.length, 1, "one undo removes the whole take");
});

test("with no editor the take goes after existing text", () => {
  const session = sessionOf(SCRIPT);
  insertElements(session, null, take);
  const paragraphs = session.script().paragraphs;
  assert.equal(paragraphs.length, SCRIPT.length + 4);
  assert.equal(plainText(paragraphs[SCRIPT.length]!.runs), "INT. KITCHEN - NIGHT");
});

function fakeEditor(session: DocumentSession, caretId: string | null) {
  const calls: NewParagraph[][] = [];
  const selections: Position[] = [];
  const editor = {
    getSelection: () => (caretId ? { anchor: { paragraphId: caretId, offset: 0 }, head: { paragraphId: caretId, offset: 0 } } : null),
    currentParagraphId: () => caretId,
    setSelection: (position: Position) => void selections.push(position),
    insertParagraphs: (paragraphs: NewParagraph[]) => (calls.push(paragraphs), []),
  } as unknown as EditorBridge;
  return { editor, calls, selections, session };
}

test("with an editor the take goes in through insertParagraphs at the caret", () => {
  const session = sessionOf(SCRIPT);
  const { editor, calls } = fakeEditor(session, session.script().paragraphs[1]!.id);
  insertElements(session, editor, take);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.map((p) => p.type), ["sceneHeading", "action", "character", "dialogue"]);
  assert.equal(session.script().paragraphs.length, SCRIPT.length, "the editor did the inserting");
});

test("with an editor and an empty caret paragraph the first element fills it", () => {
  const session = sessionOf([["action", "Maya waits."], ["action", ""]]);
  const empty = session.script().paragraphs[1]!;
  const { editor, calls, selections } = fakeEditor(session, empty.id);
  insertElements(session, editor, take);
  assert.equal(plainText(session.script().paragraphs[1]!.runs), "INT. KITCHEN - NIGHT");
  assert.equal(session.script().paragraphs[1]!.type, "sceneHeading");
  assert.deepEqual(selections, [{ paragraphId: empty.id, offset: "INT. KITCHEN - NIGHT".length }]);
  assert.deepEqual(calls[0]!.map((p) => p.type), ["action", "character", "dialogue"]);
});

test("an editor with no caret appends", () => {
  const session = sessionOf(SCRIPT);
  const { editor, calls } = fakeEditor(session, null);
  insertElements(session, editor, take);
  assert.equal(calls.length, 0);
  assert.equal(session.script().paragraphs.length, SCRIPT.length + 4);
});

test("a long script's cast keeps this scene's characters and the most used names, not just the first ones", () => {
  const rows: [ElementType, string][] = [];
  // 70 one-line characters up front, each cued once.
  for (let i = 0; i < 70; i++) rows.push(["sceneHeading", `INT. EARLY ${i} - DAY`], ["character", `EXTRA${i}`], ["dialogue", "Hi."]);
  // WREN speaks twenty times; LATE appears only in the scene being dictated.
  for (let i = 0; i < 20; i++) rows.push(["character", "WREN"], ["dialogue", "Again."]);
  rows.push(["sceneHeading", "EXT. HARBOR - DUSK"], ["character", "LATE"], ["dialogue", "Here."]);
  const session = sessionOf(rows);
  const paragraphs = session.script().paragraphs;
  const context = buildTakeContext(session.script(), paragraphs.at(-1)!.id);
  assert.equal(context.characters.length, 60);
  assert.ok(context.characters.includes("LATE"), "the scene's own character is in the cast");
  assert.ok(context.characters.includes("WREN"), "a character used often is in the cast");
  assert.equal(context.locations.length, 40);
  assert.ok(context.locations.includes("HARBOR"), "the current location is listed");
  // Below the limit nothing is reordered: names stay in order of first appearance.
  const small = buildTakeContext(sessionOf(SCRIPT).script(), null);
  assert.deepEqual(small.characters, ["MAYA", "BOB"]);
});
