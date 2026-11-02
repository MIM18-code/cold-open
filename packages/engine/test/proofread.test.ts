import assert from "node:assert/strict";
import { test } from "node:test";

import { type ElementType, type Paragraph, commonTypo, editDistance, findingId, parseCue, proofread, scriptVocabulary, spellingWords } from "../src/index.ts";

let counter = 0;
const p = (type: ElementType, text: string): Paragraph => ({ id: `p${++counter}`, type, runs: text ? [{ text }] : [] });
const script = (...rows: [ElementType, string][]) => rows.map(([type, text]) => p(type, text));
const rules = (paragraphs: Paragraph[]) => proofread(paragraphs).map((f) => f.rule);

const BASE: [ElementType, string][] = [
  ["sceneHeading", "INT. KITCHEN - DAY"],
  ["action", "MAYA pours coffee."],
  ["character", "MAYA"], ["dialogue", "Morning."],
  ["character", "MAYA"], ["dialogue", "Anyone?"],
  ["character", "MAYA"], ["dialogue", "Fine."],
];

test("edit distance counts a swap as one edit", () => {
  assert.equal(editDistance("MAYA", "MYA"), 1);
  assert.equal(editDistance("JOHNNY", "JONNY"), 1);
  assert.equal(editDistance("MAYA", "MAAY"), 1);
  assert.equal(editDistance("TOM", "TIM"), 1);
  assert.equal(editDistance("", "ABC"), 3);
});

test("a clean script has no findings", () => {
  assert.deepEqual(proofread(script(...BASE)), []);
});

test("a cue missing a letter is flagged against the common spelling", () => {
  const paragraphs = script(...BASE, ["character", "MYA"], ["dialogue", "Hello."]);
  const found = proofread(paragraphs).filter((f) => f.kind === "name");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, "name.cue");
  assert.equal(found[0]!.replacement, "MAYA");
  assert.equal(found[0]!.paragraphId, paragraphs.at(-2)!.id);
  assert.deepEqual([found[0]!.from, found[0]!.to], [0, 3]);
});

test("JOHNNY against JONNY, and extensions are kept out of the range", () => {
  const paragraphs = script(
    ["sceneHeading", "INT. BAR - NIGHT"],
    ["character", "JOHNNY"], ["dialogue", "One."], ["character", "JOHNNY"], ["dialogue", "Two."], ["character", "JOHNNY"], ["dialogue", "Three."],
    ["character", "JONNY (V.O.)"], ["dialogue", "Four."],
  );
  const [finding] = proofread(paragraphs).filter((f) => f.kind === "name");
  assert.equal(finding!.replacement, "JOHNNY");
  assert.deepEqual([finding!.from, finding!.to], [0, 5]);
});

test("similar names that are both common are left alone", () => {
  const rows: [ElementType, string][] = [["sceneHeading", "INT. BAR - NIGHT"]];
  for (let i = 0; i < 4; i++) rows.push(["character", "TOM"], ["dialogue", "Hi."], ["character", "TIM"], ["dialogue", "Hey."]);
  assert.deepEqual(proofread(script(...rows)).filter((f) => f.kind === "name"), []);
});

test("short names differing by one letter are not confused", () => {
  const rows: [ElementType, string][] = [["sceneHeading", "INT. BAR - NIGHT"]];
  for (let i = 0; i < 5; i++) rows.push(["character", "TOM"], ["dialogue", "Hi."]);
  rows.push(["character", "TIM"], ["dialogue", "Hey."]);
  assert.deepEqual(proofread(script(...rows)).filter((f) => f.kind === "name"), []);
});

test("a cue that differs from the name introduced in capitals in action is flagged", () => {
  const paragraphs = script(
    ["sceneHeading", "INT. HALL - DAY"],
    ["action", "ANDERSEN waits by the door."],
    ["action", "ANDERSEN checks a watch."],
    ["character", "ANDERSON"], ["dialogue", "Late again."],
  );
  const [finding] = proofread(paragraphs).filter((f) => f.kind === "name");
  assert.equal(finding?.rule, "name.cue");
  assert.equal(finding?.replacement, "ANDERSEN");
});

test("a misspelled name in action is flagged against the cue spelling", () => {
  const paragraphs = script(...BASE, ["action", "MYA looks up."]);
  const found = proofread(paragraphs).filter((f) => f.kind === "name");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, "name.action");
  assert.equal(found[0]!.replacement, "MAYA");
});

test("dialogue and parentheticals need a cue above", () => {
  const paragraphs = script(["sceneHeading", "INT. A - DAY"], ["action", "Quiet."], ["dialogue", "Hello?"], ["parenthetical", "(beat)"]);
  assert.deepEqual(rules(paragraphs), ["structure.dialogue-without-cue"]);
  const alone = script(["sceneHeading", "INT. A - DAY"], ["action", "Quiet."], ["parenthetical", "(beat)"]);
  assert.deepEqual(rules(alone), ["structure.parenthetical-without-cue"]);
});

test("a cue with a parenthetical then dialogue is fine; non-printing paragraphs are skipped", () => {
  const paragraphs = script(["sceneHeading", "INT. A - DAY"], ["character", "BOB"], ["note", "ask Sam"], ["parenthetical", "(low)"], ["dialogue", "Hi."]);
  assert.deepEqual(proofread(paragraphs), []);
});

test("a cue followed by something other than dialogue is flagged, the last cue is not", () => {
  const paragraphs = script(["sceneHeading", "INT. A - DAY"], ["character", "BOB"], ["action", "He leaves."], ["character", "BOB"]);
  assert.deepEqual(rules(paragraphs), ["structure.cue-without-dialogue"]);
});

test("scene headings need a prefix and a time of day", () => {
  assert.deepEqual(rules(script(["sceneHeading", "KITCHEN - DAY"])), ["structure.heading-prefix"]);
  assert.deepEqual(rules(script(["sceneHeading", "INT. KITCHEN"])), ["structure.heading-time"]);
  assert.deepEqual(rules(script(["sceneHeading", "I/E. CAR - NIGHT"])), []);
  assert.deepEqual(rules(script(["sceneHeading", "INT./EXT. CAR - NIGHT"])), []);
  assert.deepEqual(rules(script(["sceneHeading", ""])), []);
});

test("a heading prefix without a period gets a replacement", () => {
  const [finding] = proofread(script(["sceneHeading", "INT KITCHEN - DAY"]));
  assert.equal(finding!.rule, "structure.heading-period");
  assert.equal(finding!.replacement, "INT.");
  assert.deepEqual([finding!.from, finding!.to], [0, 3]);
});

test("transitions end in TO: or a period", () => {
  const [finding] = proofread(script(["transition", "CUT TO"]));
  assert.equal(finding!.replacement, "TO:");
  assert.deepEqual([finding!.from, finding!.to], [4, 6]);
  assert.equal(proofread(script(["transition", "FADE OUT"]))[0]!.replacement, "OUT.");
  assert.deepEqual(proofread(script(["transition", "CUT TO:"])), []);
  assert.deepEqual(proofread(script(["transition", "FADE OUT."])), []);
  assert.deepEqual(proofread(script(["transition", "FADE IN:"])), []);
});

test("unbalanced parentheses and quotes", () => {
  const [open] = proofread(script(["action", "She waves (badly."]));
  assert.equal(open!.rule, "punctuation.parenthesis");
  assert.equal("She waves (badly.".slice(open!.from, open!.to), "(");
  const [stray] = proofread(script(["action", "She waves) badly."]));
  assert.equal(stray!.message, "This closing parenthesis has no opening one.");
  const [fixable] = proofread(script(["character", "BOB"], ["parenthetical", "(quietly"], ["dialogue", "Hi."]));
  assert.equal(fixable!.replacement, "y)");
  const [quote] = proofread(script(["action", 'He says "no.']));
  assert.equal(quote!.rule, "punctuation.quote");
  assert.deepEqual(proofread(script(["action", 'He says "no."', ])), []);
  assert.deepEqual(proofread(script(["action", "It (sort of) works."])), []);
});

test("doubled words", () => {
  const paragraphs = script(["action", "She went to the the store."]);
  const [finding] = proofread(paragraphs);
  assert.equal(finding!.rule, "repeat.word");
  assert.equal(finding!.replacement, "the");
  assert.equal("She went to the the store.".slice(finding!.from, finding!.to), "the the");
  // Stutters and emphasis are not typos.
  assert.deepEqual(proofread(script(["action", "No no no, wait."])), []);
  assert.deepEqual(proofread(script(["action", "He had had enough."])), []);
});

test("double spaces", () => {
  const [finding] = proofread(script(["action", "One  two. Three four."]));
  assert.equal(finding!.rule, "spacing.double");
  assert.equal(finding!.replacement, " ");
  assert.deepEqual([finding!.from, finding!.to], [3, 5]);
  assert.deepEqual(proofread(script(["action", "  Indented but fine."])), []);
});

test("a sentence starting in lowercase", () => {
  const [finding] = proofread(script(["action", "He stops. then he runs."]));
  assert.equal(finding!.rule, "capital.sentence");
  assert.equal(finding!.replacement, "T");
  assert.equal("He stops. then he runs.".slice(finding!.from, finding!.to), "t");
  for (const fine of ["Well... maybe not.", "At 5 p.m. we go.", "See Mr. smith? No.", "He ran, e.g. fast.", "Wait. 2 minutes."]) {
    assert.deepEqual(proofread(script(["action", fine])).filter((f) => f.kind === "capital"), [], fine);
  }
});

test("finding IDs are stable across runs and differ between occurrences", () => {
  const paragraphs = script(["action", "The the cat and the the dog."]);
  const first = proofread(paragraphs);
  const second = proofread(structuredClone(paragraphs));
  assert.deepEqual(first.map((f) => f.id), second.map((f) => f.id));
  assert.equal(first.length, 2);
  assert.equal(new Set(first.map((f) => f.id)).size, 2);
  assert.equal(findingId("a", "p1", "x"), findingId("a", "p1", "x"));
  assert.notEqual(findingId("a", "p1", "x"), findingId("a", "p2", "x"));
});

test("an ID survives edits elsewhere in the paragraph", () => {
  const before = proofread([{ id: "x", type: "action", runs: [{ text: "Plain the the end." }] }]);
  const after = proofread([{ id: "x", type: "action", runs: [{ text: "Some words added. Plain the the end." }] }]);
  assert.equal(before[0]!.id, after[0]!.id);
  assert.notEqual(before[0]!.from, after[0]!.from);
});

test("kinds can be switched off", () => {
  const paragraphs = script(["action", "The the  end."]);
  assert.deepEqual(proofread(paragraphs, { kinds: ["repeat"] }).map((f) => f.kind), ["repeat"]);
  assert.deepEqual(proofread(paragraphs, { kinds: [] }), []);
});

test("notes inside a paragraph are never checked", () => {
  const paragraph: Paragraph = { id: "n", type: "action", runs: [{ text: "Fine. " }, { text: "the the  oops", note: true }, { text: " Done." }] };
  assert.deepEqual(proofread([paragraph]), []);
});

test("cue parsing", () => {
  assert.deepEqual(parseCue("MAYA (V.O.)"), { name: "MAYA", from: 0, to: 4, extension: " (V.O.)" });
  assert.deepEqual(parseCue("  dr. lee ^"), { name: "DR. LEE", from: 2, to: 9, extension: " ^" });
  assert.equal(parseCue(""), null);
  assert.equal(parseCue("(V.O.)"), null);
});

test("vocabulary holds names, locations and repeated capitals", () => {
  const paragraphs = script(
    ["sceneHeading", "INT. ZANZIBAR BAR - NIGHT"], ["action", "KLAXON blares. A KLAXON again. A WHOOSH."],
    ["character", "ODALYS"], ["dialogue", "Hm."],
  );
  const vocabulary = scriptVocabulary(paragraphs);
  for (const word of ["zanzibar", "odalys", "klaxon"]) assert.ok(vocabulary.has(word), word);
  assert.ok(!vocabulary.has("whoosh"));
});

test("spelling words skip caps, short words and mid-sentence proper nouns", () => {
  const words = spellingWords(p("action", "Teh dog met Brooklyn Ruth at NASA, and it can't go."));
  assert.deepEqual(words.map((w) => w.word), ["Teh", "dog", "met", "and", "can't"]);
  assert.deepEqual(spellingWords(p("character", "MAYA")), []);
  assert.deepEqual(spellingWords(p("action", "See a2b and http://x.io now.")).map((w) => w.word), ["See", "and", "now"]);
});

test("common typing slips the system checker lets through", () => {
  assert.equal(commonTypo("teh"), "the");
  assert.equal(commonTypo("Alot"), "a lot");
  assert.equal(commonTypo("toString"), undefined);
  assert.equal(commonTypo("constructor"), undefined);
  assert.equal(commonTypo("the"), undefined);
});

test("two relatives who share a name stay distinct: JERRY'S BROTHER is not a slip for JERRY'S MOTHER", () => {
  const paragraphs = script(
    ["sceneHeading", "INT. KITCHEN - DAY"],
    ["character", "JERRY'S MOTHER"], ["dialogue", "Eat."],
    ["character", "JERRY'S MOTHER"], ["dialogue", "Now."],
    ["character", "JERRY'S MOTHER"], ["dialogue", "Please."],
    ["character", "JERRY'S BROTHER"], ["dialogue", "No."],
  );
  assert.deepEqual(proofread(paragraphs).filter((f) => f.kind === "name"), []);
  // A real slip in one word of a longer name is still caught.
  const slip = script(...BASE.slice(0, 1), ["character", "JERRY'S MOTHER"], ["dialogue", "Eat."],
    ["character", "JERRY'S MOTHER"], ["dialogue", "Now."], ["character", "JERRY'S MOTHR"], ["dialogue", "Go."]);
  assert.equal(proofread(slip).find((f) => f.kind === "name")?.replacement, "JERRY'S MOTHER");
});

test("a possessive in action is the same name, not a misspelling", () => {
  const paragraphs = script(...BASE, ["action", "A radio crackles. MAYA' voice, then MAYA'S keys hit the floor."]);
  assert.deepEqual(proofread(paragraphs).filter((f) => f.kind === "name"), []);
});

test("a cue name that ends in an apostrophe is matched whole, and slips across several words are still caught", () => {
  const bottles = script(["sceneHeading", "INT. BAR - NIGHT"],
    ["character", "BOTTLES'"], ["dialogue", "One."], ["character", "BOTTLES'"], ["dialogue", "Two."], ["character", "BOTTLES'"], ["dialogue", "Three."],
    ["action", "BOTTLES' walks away."]);
  assert.deepEqual(proofread(bottles).filter((f) => f.kind === "name"), []);
  const cues = (name: string) => [["character", name], ["dialogue", "Yes."]] as [ElementType, string][];
  const dan = script(["sceneHeading", "INT. BAR - NIGHT"], ...cues("DAN SMITH"), ...cues("DAN SMITH"), ...cues("DAN SMITH"), ...cues("DNA SMITH"));
  assert.equal(proofread(dan).find((f) => f.kind === "name")?.replacement, "DAN SMITH");
  const sarah = script(["sceneHeading", "INT. BAR - NIGHT"], ...cues("SARAH CONNOR"), ...cues("SARAH CONNOR"), ...cues("SARAH CONNOR"), ...cues("SRAAH CONOR"));
  assert.equal(proofread(sarah).find((f) => f.kind === "name")?.replacement, "SARAH CONNOR");
});

test("a curly apostrophe in action matches a straight one in the cue", () => {
  const bottles = script(["sceneHeading", "INT. BAR - NIGHT"],
    ["character", "BOTTLES'"], ["dialogue", "One."], ["character", "BOTTLES'"], ["dialogue", "Two."], ["character", "BOTTLES'"], ["dialogue", "Three."],
    ["action", "BOTTLES’ walks away."]);
  assert.deepEqual(proofread(bottles).filter((f) => f.kind === "name"), []);
});
