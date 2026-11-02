import assert from "node:assert/strict";
import { test } from "node:test";

import { type ElementType, type FindingKind, type Paragraph } from "@screenplay/engine";

import { AI_CHECK_SYSTEM, chunkParagraphs, characterNames, checkPrompt, isReadable, parseAiFindings, sceneParagraphs } from "../src/renderer/features/proofread/aicheck.ts";
import { SpellCache, computeFindings, spellingFindings } from "../src/renderer/features/proofread/check.ts";

let n = 0;
const p = (type: ElementType, text: string): Paragraph => ({ id: `q${++n}`, type, runs: text ? [{ text }] : [] });

const DICTIONARY = new Set(["the", "dog", "met", "and", "went", "home", "nods", "she", "said", "walks", "door", "quiet", "room", "hello", "morning"]);
const checker = () => {
  const asked: string[] = [];
  return {
    asked,
    isMisspelled: (word: string) => (asked.push(word), !DICTIONARY.has(word.toLowerCase())),
    suggestions: (word: string) => (word.toLowerCase() === "teh" ? ["the", "tech"] : word.toLowerCase() === "dgo" ? ["dog"] : []),
  };
};
const ALL: ReadonlySet<FindingKind> = new Set(["name", "structure", "punctuation", "spacing", "repeat", "capital", "spelling"]);

test("spelling findings: suggestions with the writer's capitals, one finding per misspelling", () => {
  const spell = new SpellCache(checker());
  const paragraphs = [p("action", "Teh dog went home and teh dog met dgo.")];
  const found = spellingFindings(paragraphs, spell, new Set());
  assert.deepEqual(found.map((f) => [f.message, f.replacement]), [['"Teh" may be misspelled.', "The"], ['"teh" may be misspelled.', "the"], ['"dgo" may be misspelled.', "dog"]]);
  assert.deepEqual(found[0]!.alternatives, ["The", "Tech"]);
  assert.equal(paragraphs[0]!.runs[0]!.text.slice(found[0]!.from, found[0]!.to), "Teh");
  assert.equal(new Set(found.map((f) => f.id)).size, 3);
});

test("names, locations, learned words and capitals are not spell checked", () => {
  const asked = checker();
  const spell = new SpellCache(asked);
  const paragraphs = [
    p("sceneHeading", "INT. ZANZIBAR BAR - NIGHT"),
    p("action", "Zanzibar is quiet. Odalys walks in. Zorp nods. A WHOOSH."),
    p("character", "ODALYS"), p("dialogue", "Hello zorp."),
  ];
  const found = spellingFindings(paragraphs, spell, new Set(["zorp"]));
  assert.deepEqual(found.map((f) => f.message), []);
  assert.ok(!asked.asked.includes("Zanzibar"));
  assert.ok(!asked.asked.includes("Odalys"));
  assert.ok(!asked.asked.includes("zorp"));
});

test("the checker is asked about each word once", () => {
  const asked = checker();
  const spell = new SpellCache(asked);
  const paragraphs = Array.from({ length: 20 }, () => p("action", "The dog went home."));
  spellingFindings(paragraphs, spell, new Set());
  spellingFindings(paragraphs, spell, new Set());
  assert.equal(asked.asked.length, new Set(asked.asked).size);
  spell.clear();
  spellingFindings(paragraphs, spell, new Set());
  assert.ok(asked.asked.length > new Set(asked.asked).size);
});

test("computeFindings merges engine and spelling findings in script order and honours the kinds", () => {
  const spell = new SpellCache(checker());
  const paragraphs = [p("sceneHeading", "INT. ROOM - DAY"), p("action", "She went  home teh door."), p("dialogue", "Hello.")];
  const found = computeFindings(paragraphs, { kinds: ALL, spell, learned: new Set() });
  assert.deepEqual(found.map((f) => f.kind), ["spacing", "spelling", "structure"]);
  assert.deepEqual(computeFindings(paragraphs, { kinds: new Set(["spelling"]), spell, learned: new Set() }).map((f) => f.kind), ["spelling"]);
  assert.deepEqual(computeFindings(paragraphs, { kinds: new Set(), spell, learned: new Set() }), []);
  assert.deepEqual(computeFindings(paragraphs, { kinds: ALL, spell, learned: new Set() }).map((f) => f.id), found.map((f) => f.id));
});

const SCRIPT = [
  p("sceneHeading", "INT. ROOM - DAY"), p("action", "MAYA walks in."), p("character", "MAYA"), p("dialogue", "Morning, Ray."),
  p("sceneHeading", "EXT. YARD - DAY"), p("action", "A dog barks."),
  p("sceneHeading", "INT. HALL - NIGHT"), p("note", "to fix"), p("action", "Quiet."),
];

test("chunks end at scene boundaries and skip non-printing paragraphs", () => {
  const whole = chunkParagraphs(SCRIPT, 100_000);
  assert.equal(whole.length, 1);
  assert.ok(!whole[0]!.text.includes("to fix"));
  assert.match(whole[0]!.text, /^P1 \[sceneHeading\] INT\. ROOM - DAY\nP2 \[action\] MAYA walks in\./);
  const split = chunkParagraphs(SCRIPT, 200);
  assert.ok(split.length >= 2);
  for (const chunk of split) assert.equal(chunk.lines[0]!.paragraph.type, "sceneHeading");
  assert.equal(split.flatMap((c) => c.lines).length, 8);
  assert.equal(chunkParagraphs([], 1000).length, 0);
});

test("a scene too long for one chunk is split between paragraphs", () => {
  const long = [p("sceneHeading", "INT. A - DAY"), ...Array.from({ length: 10 }, (_, i) => p("action", `Line number ${i} of a very long scene.`))];
  const chunks = chunkParagraphs(long, 150);
  assert.ok(chunks.length > 2);
  assert.equal(chunks.flatMap((c) => c.lines).length, 11);
});

test("the scene around a paragraph", () => {
  assert.deepEqual(sceneParagraphs(SCRIPT, SCRIPT[3]!.id).map((x) => x.id), SCRIPT.slice(0, 4).map((x) => x.id));
  assert.deepEqual(sceneParagraphs(SCRIPT, SCRIPT[5]!.id).map((x) => x.id), SCRIPT.slice(4, 6).map((x) => x.id));
  assert.equal(sceneParagraphs(SCRIPT, null)[0]!.id, SCRIPT[0]!.id);
  assert.deepEqual(characterNames(SCRIPT), ["MAYA"]);
  assert.match(checkPrompt(chunkParagraphs(SCRIPT, 1e6)[0]!, ["MAYA"]), /Character names used in this script: MAYA\./);
  assert.match(AI_CHECK_SYSTEM, /Do not comment on story/);
});

test("AI findings keep only quotes found verbatim, anchored to the right paragraph", () => {
  const [chunk] = chunkParagraphs(SCRIPT, 1e6);
  const answer = JSON.stringify({ findings: [
    { paragraph: 4, quote: "Morning, Ray.", kind: "typo", message: "Ray is spelled Rae elsewhere.", replacement: "Morning, Rae." },
    { paragraph: 2, quote: "MAYA walks in.", kind: "continuity", message: "Maya was already inside.", replacement: "ignored for continuity" },
    { paragraph: 2, quote: "Maya walks in", kind: "typo", message: "wrong case, not verbatim" },
    { paragraph: 1, quote: "A dog barks.", kind: "typo", message: "Wrong paragraph number but the quote exists." },
    { quote: "invented words", message: "not in the script" },
    { paragraph: 2, quote: "", message: "empty quote" },
    { paragraph: 2, quote: "MAYA", message: "" },
  ] });
  const found = parseAiFindings(answer, chunk!);
  assert.equal(found.length, 3);
  const [typo, continuity, moved] = found;
  assert.equal(typo!.kind, "ai");
  assert.equal(typo!.rule, "ai.typo");
  assert.equal(typo!.replacement, "Morning, Rae.");
  assert.equal(typo!.paragraphId, SCRIPT[3]!.id);
  assert.deepEqual([typo!.from, typo!.to], [0, 13]);
  assert.equal(continuity!.rule, "ai.continuity");
  assert.equal(continuity!.replacement, undefined);
  assert.equal(moved!.paragraphId, SCRIPT[5]!.id);
});

test("AI answers wrapped in prose or code fences still parse; junk gives nothing; IDs are stable", () => {
  const [chunk] = chunkParagraphs(SCRIPT, 1e6);
  const body = { findings: [{ paragraph: 6, quote: "A dog barks.", kind: "typo", message: "Check." }] };
  assert.equal(parseAiFindings("```json\n" + JSON.stringify(body) + "\n```", chunk!).length, 1);
  assert.equal(parseAiFindings("Here you go: " + JSON.stringify(body) + " Done.", chunk!).length, 1);
  assert.equal(parseAiFindings(JSON.stringify(body.findings), chunk!).length, 1);
  assert.deepEqual(parseAiFindings("I found nothing wrong.", chunk!), []);
  assert.deepEqual(parseAiFindings('{"findings":[]}', chunk!), []);
  assert.equal(parseAiFindings(JSON.stringify(body), chunk!)[0]!.id, parseAiFindings(JSON.stringify(body), chunk!)[0]!.id);
});

test("a known typing slip is flagged even when the system checker accepts it, and Learn silences it", () => {
  const lenient = new SpellCache({ isMisspelled: () => false, suggestions: () => ["tech", ""] });
  const paragraphs = [p("action", "Teh dog went home, alot.")];
  const found = spellingFindings(paragraphs, lenient, new Set());
  assert.deepEqual(found.map((f) => f.replacement), ["The", "a lot"]);
  assert.deepEqual(found[0]!.alternatives, ["The", "Tech"]);
  assert.deepEqual(spellingFindings(paragraphs, lenient, new Set(["teh", "alot"])), []);
});

test("an answer with no JSON is unreadable, an empty list is not", () => {
  assert.equal(isReadable("I found nothing wrong."), false);
  assert.equal(isReadable('{"findings":[{"paragraph":1,"quote":"x"'), false);
  assert.equal(isReadable('{"findings":[]}'), true);
  assert.equal(isReadable("```json\n[]\n```"), true);
});
