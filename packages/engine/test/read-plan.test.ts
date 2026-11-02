import assert from "node:assert/strict";
import test from "node:test";
import { compileReadPlan, DEFAULT_READ_OPTIONS, NARRATOR, readRoles, reconcileCast, speechChunks } from "../src/read-plan.ts";
import { dialogueReport, notesReport, elementReport, sceneSpeakerReport, reportHtml, tagReport, tagsByTag } from "../src/writing-reports.ts";
import { paginate } from "../src/pagination.ts";
import { parseFdx, writeFdx } from "../src/fdx.ts";
import type { Paragraph, Script } from "../src/model.ts";
const p = (id: string, type: Paragraph["type"], text: string): Paragraph => ({ id, type, runs: [{ text }] });
const script: Script = { titlePage: [], paragraphs: [
  p("s", "sceneHeading", "INT. KITCHEN - DAY"), p("a", "action", "A door opens."),
  p("c", "character", "MAYA (V.O.)"), p("d", "parenthetical", "(quietly)"), p("e", "dialogue", "I know."),
  { ...p("f", "dialogue", "No more."), runs: [{ text: "No " }, { text: "secret note", note: true }, { text: "more." }] },
  p("n", "note", "Change the ending."), p("c2", "character", "MAYA (CONT'D)"), p("g", "dialogue", "We should leave."),
  p("s2", "sceneHeading", "OMITTED"), p("hidden", "action", "Do not read this."),
] };
test("read plans omit notes and cues, preserve spoken text, and normalize speaker extensions", () => {
  const plan = compileReadPlan(script);
  assert.deepEqual(plan.map((c) => c.text), ["A door opens.", "I know. No more.", "We should leave."]);
  assert.deepEqual(plan.map((c) => c.speaker), [NARRATOR, "MAYA", "MAYA"]);
  assert.equal(plan[1]!.paragraphIds[0], "e");
  assert.equal(compileReadPlan(script, { ...DEFAULT_READ_OPTIONS, action: false }).length, 2);
  assert(compileReadPlan(script, { ...DEFAULT_READ_OPTIONS, headings: true, parentheticals: true, names: true }).some((c) => c.text === "quietly"));
});
test("large paragraphs are bounded without losing words or splitting surrogate pairs", () => {
  const text = Array.from({ length: 250 }, (_, i) => `word${i} 😀.`).join(" ");
  const chunks = speechChunks(text, 100);
  assert(chunks.every((s) => s.length <= 100)); assert.equal(chunks.join(" "), text);
  assert.throws(() => speechChunks(text, 3));
});
test("dual-dialogue metadata survives a deterministic sequential read plan", () => {
  const source = { ...script, paragraphs: script.paragraphs.map((p) => p.id === "e" ? { ...p, dual: { block: "pair", side: 1 as const } } : p) };
  assert.equal(compileReadPlan(source).find((c) => c.id.startsWith("e:"))?.dual, "pair");
});
test("stable cue IDs keep casting through renames and additions", () => {
  const roles = readRoles(script); assert.equal(roles.length, 1);
  const previous = reconcileCast(roles, []); previous[0]!.voices.ming = "US_Emma"; previous[0]!.locked = true;
  const renamed = roles.map((role) => ({ ...role, name: "MARIA" }));
  const next = reconcileCast(renamed, previous);
  assert.equal(next[0]!.id, "c"); assert.equal(next[0]!.voices.ming, "US_Emma"); assert(next[0]!.locked);
});
test("dialogue report includes directions, extensions and full multiline speeches, not notes", () => {
  const pagination = paginate(script), rows = dialogueReport(script, pagination);
  assert.equal(rows.length, 2); assert.equal(rows[0]!.cue, "MAYA (V.O.)");
  assert.equal(rows[0]!.parenthetical, "(quietly)"); assert.equal(rows[0]!.dialogue, "I know.\nNo more.");
  assert.equal(rows[0]!.page, "1"); assert.equal(rows[0]!.words, 4);
  const cast = sceneSpeakerReport(script, pagination); assert.equal(cast.length, 1); assert.equal(cast[0]!.speeches, 2);
  const notes = notesReport(script, pagination); assert.equal(notes.length, 2); assert.equal(notes[0]!.text, "secret note");
  assert.equal(elementReport(script, pagination, new Set(["dialogue"])).length, 3);
});
test("monologue boundary and printed reports escape all script markup", () => {
  const source = { titlePage: [], paragraphs: [p("c", "character", "MAYA"), p("d", "dialogue", Array(101).fill("word").join(" "))] };
  assert(dialogueReport(source, paginate(source))[0]!.monologue);
  const html = reportHtml('<script>bad()</script>', ["<img>"], [['<img src=x onerror=alert(1)>']]);
  assert(!html.includes("<script>")); assert(!html.includes("<img")); assert(html.includes("&lt;img"));
});

// Synthetic metadata, never an actual screenplay. The original FDX extras remain byte-equivalent.
test("FDX notes and tags are reportable without mutating their preserved XML", () => {
  const xml = `<FinalDraft DocumentType="Script" Template="No" Version="1"><Content>
    <Paragraph Type="Scene Heading" id="scene"><Text>INT. ROOM - DAY</Text></Paragraph>
    <Paragraph Type="Action" id="action"><Text>A </Text><Text TagNumber="7">silver </Text><Text TagNumber="7" Style="Bold">key</Text><Text>.</Text><ScriptNote><Paragraph><Text>Keep this prop.</Text></Paragraph></ScriptNote></Paragraph>
  </Content><ScriptNotes><ScriptNote Range="18,22"><Paragraph><Text>Global note.</Text></Paragraph></ScriptNote></ScriptNotes>
  <TagData><TagCategories><TagCategory Id="props" Name="Props" Number="1"/></TagCategories><TagDefinitions><TagDefinition Id="key" CatId="props" Number="7" Label="Silver key"/></TagDefinitions></TagData></FinalDraft>`;
  const parsed = parseFdx(xml), before = writeFdx(parsed), pages = paginate(parsed);
  const notes = notesReport(parsed, pages); assert.equal(notes.length, 2); assert.equal(notes[0]!.paragraphId, "action"); assert.equal(notes[1]!.page, "1"); assert.equal(notes[1]!.paragraphId, "action");
  const tags = tagReport(parsed, pages); assert.equal(tags.length, 1); assert.equal(tags[0]!.text, "silver key"); assert.equal(tags[0]!.category, "Props"); assert.equal(tags[0]!.label, "Silver key");
  assert.equal(tagsByTag(tags)[0]!.scenes, "1"); assert.equal(writeFdx(parsed), before);
  parsed.paragraphs[1]!.runs[1]!.fdx!.TagNumber = "999";
  assert.equal(tagReport(parsed, pages)[0]!.category, "Unresolved category");
});

test("joined speech retains exact source spans around inline notes", () => {
  const cue = compileReadPlan(script)[1]!;
  assert.deepEqual(cue.source, [
    { paragraphId: "e", from: 0, to: 7 },
    { paragraphId: "f", from: 0, to: 3 },
    { paragraphId: "f", from: 14, to: 19 },
  ]);
  assert.deepEqual(cue.paragraphIds, ["e", "f"]);
  assert.equal(cue.sceneId, "s");
  assert.equal(cue.speaker, "MAYA");
});
test("MORE and CONT'D page labels never become spoken words, even with narration enabled", () => {
  const source: Script = { titlePage: [], paragraphs: [p("c", "character", "MAYA (CONT'D)"),
    p("d", "dialogue", "Hello."), p("more", "parenthetical", "(MORE)"),
    p("continued", "action", "CONT’D"), p("d2", "dialogue", "Goodbye.")] };
  const cues = compileReadPlan(source, { action: true, names: true, parentheticals: true, headings: true });
  assert.deepEqual(cues.map((cue) => cue.text), ["MAYA", "Hello. Goodbye."]);
  assert(cues.every((cue) => cue.source.length));
});
test("long speech chunks retain offsets and dual lane without truncation", () => {
  const text = "  " + "A long sentence. ".repeat(200);
  const source: Script = { titlePage: [], paragraphs: [p("c", "character", "MAYA"),
    { ...p("d", "dialogue", text), dual: { block: "pair", side: 2 } }] };
  const cues = compileReadPlan(source);
  assert(cues.length > 1);
  assert(cues.every((cue) => cue.lane === 2 && cue.dual === "pair" && cue.speaker === "MAYA"));
  assert.equal(cues.map((cue) => cue.text).join(" "), text.trim());
  for (const cue of cues) assert.equal(cue.source.map((span) => text.slice(span.from, span.to)).join(""), cue.text);
});

test("a character who says only \"More\", \"Continued\" or \"cont'd\" is still heard", () => {
  const source: Script = { titlePage: [], paragraphs: [p("c", "character", "MAYA"), p("d", "dialogue", "More"),
    p("c2", "character", "ELI"), p("d2", "dialogue", "Continued"), p("c3", "character", "MAYA"), p("d3", "lyrics", "cont'd"),
    p("more", "parenthetical", "(MORE)"), p("cont", "action", "CONTINUED:")] };
  const cues = compileReadPlan(source, { ...DEFAULT_READ_OPTIONS, names: false, action: true });
  assert.deepEqual(cues.map((cue) => cue.text), ["More", "Continued", "cont'd"]);
});
