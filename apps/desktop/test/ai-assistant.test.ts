import assert from "node:assert/strict";
import { test } from "node:test";

import { type ElementType, type Paragraph, type Script, parseFountain } from "@screenplay/engine";

import { ASSISTANT_PROMPT, QUICK_ACTIONS, assistantSystem, buildScriptContext, selectedText } from "../src/renderer/features/assistant/context.ts";
import { locate, splitAnswer } from "../src/renderer/features/assistant/suggestions.ts";

const SAMPLE = [
  "INT. OFFICE - DAY", "", "Nell waits by the window.", "", "NELL", "Well?", "",
  "EXT. YARD - NIGHT", "", "Rain falls on the car.", "", "RAY", "Get in.", "",
  "INT. CAR - NIGHT", "", "They drive in silence.", "",
].join("\n");
const script = (): Script => parseFountain(SAMPLE);

test("the whole script fits: every scene is marked and nothing is dropped", () => {
  const s = script();
  const context = buildScriptContext(s, s.paragraphs[2]!.id, 100_000);
  assert.equal(context.truncated, false);
  assert.equal(context.total, 3);
  assert.equal(context.current, "Scene 1 (INT. OFFICE - DAY)");
  assert.match(context.text, /\[Scene 1 \(INT\. OFFICE - DAY\)\]\nINT\. OFFICE - DAY\n\nNell waits/);
  assert.match(context.text, /\[Scene 3 \(INT\. CAR - NIGHT\)\]/);
  assert.ok(context.text.includes("Get in."));
});

test("scene numbers from the script are used in the markers", () => {
  const s = script();
  s.paragraphs[0]!.sceneNumber = "12A";
  assert.match(buildScriptContext(s, null, 100_000).text, /\[Scene 12A \(INT\. OFFICE - DAY\)\]/);
});

test("over budget: an outline of every scene, the current scene and its neighbours in full", () => {
  const s = script();
  const full = buildScriptContext(s, null, 1e6).text.length;
  const current = s.paragraphs.find((p) => p.runs[0]?.text === "Rain falls on the car.")!;
  const context = buildScriptContext(s, current.id, full - 60);
  assert.equal(context.truncated, true);
  assert.equal(context.current, "Scene 2 (EXT. YARD - NIGHT)");
  assert.ok(context.text.startsWith("[Outline of all scenes]"));
  for (const heading of ["INT. OFFICE - DAY", "EXT. YARD - NIGHT", "INT. CAR - NIGHT"]) assert.ok(context.text.includes(heading), heading);
  assert.ok(context.text.includes("Rain falls on the car."));
  assert.ok(context.included < 3);
  assert.ok(context.text.length <= full - 60 + 220, "within budget plus the note");
});

test("the current scene is always included, even when it alone is over budget", () => {
  const s = script();
  const current = s.paragraphs.find((p) => p.runs[0]?.text === "Rain falls on the car.")!;
  const context = buildScriptContext(s, current.id, 10);
  assert.ok(context.text.includes("Rain falls on the car."));
  assert.equal(context.included, 1);
  assert.ok(!context.text.includes("Nell waits"));
});

test("an empty script and one with text before the first heading", () => {
  const empty = buildScriptContext({ titlePage: [], paragraphs: [] }, null, 1000);
  assert.deepEqual([empty.text, empty.current, empty.total], ["", null, 0]);
  const lead: Paragraph = { id: "a", type: "action" as ElementType, runs: [{ text: "Opening text." }] };
  const withLead = buildScriptContext({ titlePage: [], paragraphs: [lead, ...script().paragraphs] }, "a", 100_000);
  assert.match(withLead.text, /^\[Before the first scene\]\nOpening text\./);
  assert.equal(withLead.total, 3);
});

test("the system prompt carries the rules, the script, the current scene and a selection", () => {
  const s = script();
  const system = assistantSystem({ context: buildScriptContext(s, s.paragraphs[2]!.id, 1e6), selection: "  Nell waits  " });
  assert.ok(system.startsWith(ASSISTANT_PROMPT));
  assert.match(system, /No flattery/);
  assert.match(system, /no story notes|Give no story notes/i);
  assert.match(system, /The writer is working in Scene 1/);
  assert.match(system, /selected this text:\n"""\nNell waits\n"""/);
  assert.ok(!assistantSystem({ context: buildScriptContext(s, null, 1e6) }).includes("selected this text"));
});

test("quick actions are fixed questions, not open-ended advice", () => {
  assert.match(QUICK_ACTIONS.notes("Scene 4"), /Scene 4/);
  assert.match(QUICK_ACTIONS.summarize("Scene 4"), /Facts only/);
  assert.match(QUICK_ACTIONS.continuity(), /If you find none, say so/);
});

test("selected text across paragraphs, in either direction", () => {
  const s = script();
  const [, action, cue, line] = s.paragraphs;
  assert.equal(selectedText(s, { paragraphId: action!.id, offset: 5 }, { paragraphId: action!.id, offset: 10 }), "waits");
  assert.equal(selectedText(s, { paragraphId: action!.id, offset: 18 }, { paragraphId: line!.id, offset: 2 }), "window.\nNELL\nWe");
  assert.equal(selectedText(s, { paragraphId: line!.id, offset: 2 }, { paragraphId: cue!.id, offset: 0 }), "NELL\nWe");
  assert.equal(selectedText(s, { paragraphId: "nope", offset: 0 }, { paragraphId: line!.id, offset: 2 }), "");
});

test("answers split into prose and suggestion cards", () => {
  const answer = [
    "Scene 2 has the car in the rain.",
    "```suggestion",
    '{"scene":"2","find":"Rain falls on the car.","replace":"Rain beats on the car.","why":"Stronger verb."}',
    "```",
    "Scene 3 follows.",
    "```suggestion",
    "not json",
    "```",
  ].join("\n");
  const pieces = splitAnswer(answer);
  assert.deepEqual(pieces.map((x) => x.type), ["text", "suggestion", "text"]);
  const suggestion = pieces[1] as { type: "suggestion"; suggestion: { find: string; replace: string; why?: string; scene?: string } };
  assert.deepEqual(suggestion.suggestion, { find: "Rain falls on the car.", replace: "Rain beats on the car.", why: "Stronger verb.", scene: "2" });
  assert.match((pieces[2] as { text: string }).text, /Scene 3 follows\.[\s\S]*not json/);
  assert.deepEqual(splitAnswer("Just text."), [{ type: "text", text: "Just text." }]);
  assert.deepEqual(splitAnswer('```suggestion\n{"find":"a","replace":"a"}\n```').map((x) => x.type), ["text"]);
});

test("a suggestion is applied only where its text is found exactly once", () => {
  const s = script();
  const rain = s.paragraphs.find((p) => p.runs[0]?.text === "Rain falls on the car.")!;
  const found = locate(s, { find: "falls on", replace: "pours on" });
  assert.deepEqual(found, { paragraphId: rain.id, from: 5, to: 13 });
  assert.match((locate(s, { find: "Rain beats on the car.", replace: "x" }) as { error: string }).error, /not in the script/);
  // "in" appears in several scenes; a scene hint narrows it only if that leaves one.
  assert.match((locate(s, { find: "in", replace: "x" }) as { error: string }).error, /appears \d+ times/);
  const hinted = locate(s, { find: "waits", replace: "stands", scene: "1" });
  assert.ok(!("error" in hinted));
  const twice: Script = { titlePage: [], paragraphs: [
    { id: "h1", type: "sceneHeading", runs: [{ text: "INT. A - DAY" }] }, { id: "a1", type: "action", runs: [{ text: "He nods." }] },
    { id: "h2", type: "sceneHeading", runs: [{ text: "INT. B - DAY" }] }, { id: "a2", type: "action", runs: [{ text: "He nods." }] },
  ] };
  assert.match((locate(twice, { find: "He nods.", replace: "x" }) as { error: string }).error, /appears 2 times/);
  assert.deepEqual(locate(twice, { find: "He nods.", replace: "x", scene: "2" }), { paragraphId: "a2", from: 0, to: 8 });
});

test("a suggestion for one scene never lands in another when its text has left that scene", () => {
  // The suggestion targets scene 2; a co-writer has since changed that line, so only scene 1 still has the text.
  const edited: Script = { titlePage: [], paragraphs: [
    { id: "h1", type: "sceneHeading", runs: [{ text: "INT. A - DAY" }] }, { id: "a1", type: "action", runs: [{ text: "He nods." }] },
    { id: "h2", type: "sceneHeading", runs: [{ text: "INT. B - DAY" }] }, { id: "a2", type: "action", runs: [{ text: "He shrugs." }] },
  ] };
  const located = locate(edited, { find: "He nods.", replace: "He smiles.", scene: "2" });
  assert.ok("error" in located, "must not fall back to scene 1");
  assert.match(located.error, /scene 2/);
});
