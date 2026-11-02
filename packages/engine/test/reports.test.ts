import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Paragraph, type Script, ScreenplayDoc, applyTextEdits, castList, characterName, characterReport, findMentions, locationReport, paginate, parseFdx, parseFountain, parseHeading,
  plainText, planRename, sceneReport, scenesOf, scriptStatistics, sidesScript, toCsv, writeFdx, writeFountain,
} from "../src/index.ts";

const SOURCE = `Title: SYNTHETIC
Author: Test Writer

EXT. SALVAGE YARD - DAWN

Rows of crushed sedans. NELL (40s) kicks the tire. A tall man, VERN (60), watches from the shed.

NELL
(to Vern)
You and me had a deal, Nell says to nobody.

VERN (V.O.)
Nobody asked you.

INT. SHED - DAY

Vern sets down a mug. Nell enters.

NELL (CONT'D)
Where is it?

VERN
Gone.

NELL
Gone where, Vern?

INT. SHED - NIGHT

The shed is dark. NELL waits. A stranger, MARA (20s), steps in.

MARA
Hello.

EXT. ROAD - CONTINUOUS

Empty road.
`;

const script = parseFountain(SOURCE);

test("normalizes cue names", () => {
  assert.equal(characterName("ROBERT (V.O.)"), "ROBERT");
  assert.equal(characterName("Robert (CONT'D)"), "ROBERT");
  assert.equal(characterName("ROBERT (O.S.) (CONT'D)"), "ROBERT");
  assert.equal(characterName("ROBERT CONT'D"), "ROBERT");
  assert.equal(characterName("  Mary   Ann ^"), "MARY ANN");
});

test("parses headings", () => {
  assert.deepEqual(parseHeading("INT. KITCHEN - NIGHT"), { setting: "INT", location: "KITCHEN", timeOfDay: "NIGHT" });
  assert.deepEqual(parseHeading("EXT./INT. CAR (MOVING) - DAY"), { setting: "INT/EXT", location: "CAR", timeOfDay: "DAY" });
  assert.deepEqual(parseHeading("I/E. DOORWAY -- LATER"), { setting: "INT/EXT", location: "DOORWAY", timeOfDay: "LATER" });
  assert.deepEqual(parseHeading("12 INT. THE BAR - THE WEST SIDE - DUSK"), { setting: "INT", location: "THE BAR - THE WEST SIDE", timeOfDay: "DUSK" });
  assert.deepEqual(parseHeading("EXT. FIELD"), { setting: "EXT", location: "FIELD", timeOfDay: "" });
  assert.deepEqual(parseHeading("INTERCUT PHONE CALL"), { setting: "", location: "INTERCUT PHONE CALL", timeOfDay: "" });
});

test("character report counts speeches, scenes, words and pages", () => {
  const rows = characterReport(script);
  assert.deepEqual(rows.map((r) => r.name), ["NELL", "VERN", "MARA"]);
  const nell = rows[0]!;
  assert.equal(nell.speaking, true);
  assert.equal(nell.speeches, 3);
  assert.equal(nell.dialogueScenes, 2);
  assert.equal(nell.scenes, 3);
  assert.equal(nell.words, 10 + 3 + 3);
  assert.equal(nell.firstScene, "1");
  assert.equal(nell.lastScene, "3");
  assert.equal(nell.firstPage, "1");
  assert.equal(nell.pages, 1);
  const vern = rows[1]!;
  assert.equal(vern.speeches, 2);
  assert.equal(vern.scenes, 2);
  assert.equal(vern.dialogueScenes, 2);
  const mara = rows[2]!;
  assert.equal(mara.speeches, 1);
  assert.equal(mara.firstScene, "3");
  // Nell is first named in the opening action, before her first cue.
  assert.equal(script.paragraphs.find((p) => p.id === nell.firstParagraphId)?.type, "action");
  assert.equal(script.paragraphs.find((p) => p.id === mara.firstParagraphId)?.type, "action");
});

test("characters introduced in caps in action but silent get their own row", () => {
  const withSilent = parseFountain(`EXT. YARD - DAY

GUS (50s) leans on a fence. Later Gus nods. A dog, REX, barks.

INT. HOUSE - DAY

Gus comes in.

FADE OUT.
`);
  const rows = characterReport(withSilent);
  assert.deepEqual(rows.map((r) => [r.name, r.speaking, r.speeches, r.scenes]), [["GUS", false, 0, 2]]);
  assert.equal(rows[0]!.firstScene, "1");
  assert.equal(rows[0]!.words, 0);
});

test("scene report: heading parts, characters, words, eighths", () => {
  const rows = sceneReport(script);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => [r.number, r.setting, r.location, r.timeOfDay]), [
    ["1", "EXT", "SALVAGE YARD", "DAWN"],
    ["2", "INT", "SHED", "DAY"],
    ["3", "INT", "SHED", "NIGHT"],
    ["4", "EXT", "ROAD", "CONTINUOUS"],
  ]);
  assert.deepEqual(rows[1]!.characters, ["NELL", "VERN"]);
  assert.deepEqual(rows[3]!.characters, []);
  assert.equal(rows[3]!.words, 2);
  assert.ok(rows.every((r) => r.eighths >= 1 && r.page === "1"));
  assert.match(rows[0]!.length, /^\d/);
});

test("scene numbers use the printed number when the script has one", () => {
  const numbered = parseFountain("INT. A - DAY #12#\n\nText.\n\nINT. B - DAY\n\nMore.\n");
  assert.deepEqual(sceneReport(numbered).map((r) => r.number), ["12", "2"]);
});

test("location report groups scenes by location and INT/EXT", () => {
  const rows = locationReport(script);
  assert.deepEqual(rows.map((r) => [r.setting, r.location, r.scenes, r.sceneNumbers.join(",")]), [
    ["EXT", "SALVAGE YARD", 1, "1"],
    ["INT", "SHED", 2, "2,3"],
    ["EXT", "ROAD", 1, "4"],
  ]);
  const total = sceneReport(script).reduce((sum, r) => sum + r.eighths, 0);
  assert.equal(rows.reduce((sum, r) => sum + r.eighths, 0), total);
  assert.equal(script.paragraphs.find((p) => p.id === rows[1]!.firstHeadingId)?.type, "sceneHeading");
});

test("statistics", () => {
  const stats = scriptStatistics(script);
  assert.equal(stats.scenes, 4);
  assert.equal(stats.pages, 1);
  assert.equal(stats.speakingCharacters, 3);
  assert.equal(stats.locations, 3);
  assert.equal(stats.elements.sceneHeading, 4);
  assert.equal(stats.elements.character, 6);
  assert.ok(stats.dialogueWords > 0 && stats.actionWords > 0);
  assert.ok(Math.abs(stats.dialogueShare + stats.actionShare - 1) < 1e-9);
  assert.equal(stats.longestScene?.eighths, Math.max(...sceneReport(script).map((r) => r.eighths)));
});

test("cast list in order of first speech", () => {
  assert.deepEqual(castList(script), [
    { name: "NELL", speeches: 3, firstScene: "1" },
    { name: "VERN", speeches: 2, firstScene: "1" },
    { name: "MARA", speeches: 1, firstScene: "3" },
  ]);
});

test("sides keep chosen scenes in script order, the title page and the scene numbers", () => {
  const scenes = scenesOf(script.paragraphs);
  const sides = sidesScript(script, [scenes[2]!.sceneId, scenes[0]!.sceneId]);
  assert.deepEqual(sides.titlePage, script.titlePage);
  const headings = sides.paragraphs.filter((p) => p.type === "sceneHeading");
  assert.deepEqual(headings.map((p) => [plainText(p.runs), p.sceneNumber]), [["EXT. SALVAGE YARD - DAWN", "1"], ["INT. SHED - NIGHT", "3"]]);
  assert.ok(sides.paragraphs.some((p) => plainText(p.runs).includes("MARA")));
  assert.ok(!sides.paragraphs.some((p) => plainText(p.runs).includes("Where is it?")));
  // The source script is untouched.
  assert.equal(script.paragraphs.find((p) => p.type === "sceneHeading")?.sceneNumber, undefined);
  // Sides survive both export formats.
  assert.equal(scenesOf(parseFountain(writeFountain(sides)).paragraphs).length, 2);
  assert.equal(scenesOf(parseFdx(writeFdx(sides)).paragraphs).length, 2);
  assert.deepEqual(sidesScript(script, []).paragraphs, []);
});

test("mentions are whole-word and case-aware", () => {
  assert.deepEqual(
    findMentions("ROBERT runs. Robert's gun. robert? Roberta. ROBERT-san", "Robert").map((m) => [m.from, m.to, m.style]),
    [[0, 6, "caps"], [13, 19, "proper"]],
  );
  assert.deepEqual(findMentions("John Smith and JOHN  SMITH", "John Smith").map((m) => m.style), ["proper", "caps"]);
});

function applyPlan(doc: ScreenplayDoc, plan: ReturnType<typeof planRename>): void {
  for (const edit of plan.edits) {
    doc.insertText(edit.paragraphId, edit.to, edit.text);
    doc.deleteText(edit.paragraphId, edit.from, edit.to - edit.from);
  }
}

test("rename plans cues and mentions and keeps extensions", () => {
  const plan = planRename(script, "Vern", "Bo");
  assert.equal(plan.cues, 2);
  assert.equal(plan.upper, "BO");
  assert.equal(plan.proper, "Bo");
  // Mentions: "VERN (60)" in action, "(to Vern)" is Nell's, "Vern sets down", "Gone where, Vern?".
  assert.equal(plan.mentions, 3 + 1);
  const doc = ScreenplayDoc.fromScript(script);
  applyPlan(doc, plan);
  const after = doc.toScript();
  const texts = after.paragraphs.map((p) => plainText(p.runs));
  assert.ok(texts.includes("BO (V.O.)"));
  assert.ok(texts.includes("BO"));
  assert.ok(texts.includes("(to Bo)"));
  assert.ok(texts.includes("Gone where, Bo?"));
  assert.ok(texts.some((t) => t.includes("BO (60)")));
  assert.ok(!texts.some((t) => /vern/i.test(t)));
  assert.equal(after.paragraphs.length, script.paragraphs.length);
  const changed = new Set(plan.edits.map((e) => e.paragraphId));
  script.paragraphs.forEach((p, i) => {
    if (!changed.has(p.id)) assert.equal(plainText(after.paragraphs[i]!.runs), plainText(p.runs));
  });
});

test("rename keeps formatting of the replaced text and leaves headings and lower case alone", () => {
  const doc = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [
    { id: "h", type: "sceneHeading", runs: [{ text: "INT. ROBERT'S HOUSE - DAY" }] },
    { id: "a", type: "action", runs: [{ text: "Hi " }, { text: "Robert", bold: true }, { text: " and a robert." }] },
  ] });
  const plan = planRename(doc.toScript(), "ROBERT", "Bob");
  assert.deepEqual(plan.edits.map((e) => [e.paragraphId, e.text]), [["a", "Bob"]]);
  applyPlan(doc, plan);
  assert.deepEqual(doc.toScript().paragraphs[1]!.runs, [{ text: "Hi " }, { text: "Bob", bold: true }, { text: " and a robert." }]);
});

test("renaming to the same name or an empty name changes nothing", () => {
  assert.equal(planRename(script, "NELL", "Nell").edits.length, 0);
  assert.equal(planRename(script, "NELL", "  ").edits.length, 0);
  assert.equal(planRename(script, "ZELDA", "Somebody").edits.length, 0);
});

test("CSV quotes commas, quotes and line breaks and starts with a byte order mark", () => {
  const csv = toCsv(["Name", "Note"], [["A, B", 'say "hi"'], ["C", "two\nlines"], ["Zoë", 3]]);
  assert.equal(csv, '﻿Name,Note\r\n"A, B","say ""hi"""\r\nC,"two\nlines"\r\nZoë,3\r\n');
});

test("reports and a rename plan run on a long script in a few seconds", () => {
  const lines: string[] = [];
  for (let i = 0; i < 300; i++) {
    lines.push(`INT. PLACE ${i % 17} - DAY`, "", `Action with ALICE (30s) and BOB number ${i}.`, "", "ALICE", `Line ${i} of dialogue that runs on a little.`, "", "BOB", "Reply.", "");
  }
  const big = parseFountain(lines.join("\n"));
  const pagination = paginate(big);
  const started = performance.now();
  assert.equal(characterReport(big, pagination).length, 2);
  const scenes = sceneReport(big, pagination);
  locationReport(big, pagination, scenes);
  scriptStatistics(big, pagination, scenes);
  const plan = planRename(big, "ALICE", "AL");
  assert.equal(plan.cues, 300);
  assert.equal(plan.mentions, 300);
  assert.ok(performance.now() - started < 3000);
});

test("locations and statistics from a scene report already made are the same as from scratch", () => {
  const pagination = paginate(script);
  const scenes = sceneReport(script, pagination);
  assert.deepEqual(locationReport(script, pagination, scenes), locationReport(script, pagination));
  assert.deepEqual(scriptStatistics(script, pagination, scenes), scriptStatistics(script, pagination));
});

test("applyTextEdits gives the same document as one edit at a time, with formatting kept, and is fast on a long script", () => {
  const paragraphs: Paragraph[] = [];
  for (let i = 0; i < 1500; i++) {
    paragraphs.push({ id: `h${i}`, type: "sceneHeading", runs: [{ text: `INT. ROOM ${i} - DAY` }] });
    paragraphs.push({ id: `a${i}`, type: "action", runs: [{ text: "Then " }, { text: "Vern", bold: true }, { text: ` and VERN, again Vern${i % 2 ? "'s" : ""}. Line\nbreak Vern.` }] });
    paragraphs.push({ id: `c${i}`, type: "character", runs: [{ text: "VERN (V.O.)" }] });
    paragraphs.push({ id: `d${i}`, type: "dialogue", runs: [{ text: "Vern?" }] });
  }
  const source: Script = { titlePage: [], paragraphs };
  const plan = planRename(source, "VERN", "Bartholomew");
  assert.equal(plan.cues, 1500);
  const slow = ScreenplayDoc.fromScript(structuredClone(source));
  const few = { ...plan, edits: plan.edits.slice(0, 40) };
  applyPlan(slow, few);
  const fast = ScreenplayDoc.fromScript(structuredClone(source));
  applyTextEdits(fast, few.edits);
  assert.deepEqual(fast.toScript(), slow.toScript());
  // Fast means one pass for the whole plan, not one per edit: all of it takes less time than applying a third of
  // it one edit at a time. Both are timed here, so a busy machine slows both alike.
  const whole = ScreenplayDoc.fromScript(structuredClone(source));
  let started = performance.now();
  whole.ydoc.transact(() => applyTextEdits(whole, plan.edits));
  const batch = performance.now() - started;
  const oneByOne = ScreenplayDoc.fromScript(structuredClone(source));
  started = performance.now();
  oneByOne.ydoc.transact(() => applyPlan(oneByOne, { ...plan, edits: plan.edits.slice(0, plan.edits.length / 3) }));
  const third = performance.now() - started;
  assert.ok(batch < third, `the whole plan took ${batch.toFixed(0)} ms, a third of it one edit at a time ${third.toFixed(0)} ms`);
  const after = whole.toScript();
  assert.equal(after.paragraphs.length, paragraphs.length);
  assert.deepEqual(after.paragraphs[1]!.runs.slice(0, 2), [{ text: "Then " }, { text: "Bartholomew", bold: true }]);
  assert.ok(after.paragraphs.every((p) => !/vern/i.test(plainText(p.runs))));
  assert.equal(plainText(after.paragraphs[2]!.runs), "BARTHOLOMEW (V.O.)");
});

test("a title before an introduced name stays part of it", () => {
  const rows = characterReport({ titlePage: [], paragraphs: [
    { id: "h", type: "sceneHeading", runs: [{ text: "INT. CLINIC - DAY" }] },
    { id: "a", type: "action", runs: [{ text: "DR. PARK (50s) washes up. MRS. LEE, 70, waits. Later PARK nods." }] },
  ] }).map((row) => row.name);
  assert.deepEqual(rows, ["DR. PARK", "MRS. LEE"]);
});

test("CSV cells that a spreadsheet would run as formulas are quoted as text", () => {
  const csv = toCsv(["Name", "Count"], [["=HYPERLINK(\"x\")", -3], ["@SUM(A1)", 2], ["-1+1", 1], ["Normal", 0]]);
  assert.equal(csv, '\ufeffName,Count\r\n"\'=HYPERLINK(""x"")",-3\r\n\'@SUM(A1),2\r\n\'-1+1,1\r\nNormal,0\r\n');
});


test("multi-camera sides preserve scene page breaks in pagination and FDX", () => {
  const script: Script = { titlePage: [], template: "multiCamera", paragraphs: [
    { id: "h1", sceneId: "s1", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] },
    { id: "a1", type: "action", runs: [{ text: "A door opens." }] },
    { id: "h2", sceneId: "s2", type: "sceneHeading", runs: [{ text: "INT. HALL - DAY" }] },
    { id: "a2", type: "action", runs: [{ text: "A door closes." }] },
  ] };
  const sides = sidesScript(script, ["s1", "s2"]);
  assert.equal(sides.template, "multiCamera");
  assert.equal(paginate(sides).pages.length, 2);
  assert.equal(parseFdx(writeFdx(sides)).paragraphs.find((part) => part.id === "h2")?.startsNewPage, true);
});
