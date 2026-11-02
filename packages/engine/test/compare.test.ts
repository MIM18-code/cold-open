import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Paragraph, type Script, ScreenplayDoc, compareScripts, diffWords, insertedRanges, parseFdx, parseFountain, plainText, writeFdx, writeFountain,
} from "../src/index.ts";

const BASE = `Title: DRAFT ONE

INT. KITCHEN - DAY

Mara stirs a pot. The radio hums.

MARA
Dinner is almost ready.

TOM
I'm not hungry.

EXT. YARD - NIGHT

Tom sits on the step and watches the fence.

TOM
Somebody is out there.

INT. GARAGE - DAY

Boxes everywhere. Dust in the light.
`;

const REVISED = `Title: DRAFT TWO

INT. KITCHEN - DAY

Mara stirs a pot. The radio hums softly.

MARA
Dinner is almost ready, Tom.

TOM
I'm not hungry.

TOM
Seriously.

EXT. YARD - NIGHT

Tom sits on the step and watches the fence.

TOM
Somebody is out there.

INT. ATTIC - NIGHT

New scene entirely.
`;

const text = (p: Paragraph) => plainText(p.runs);

test("diffWords marks inserted and deleted words", () => {
  const parts = diffWords("the quick brown fox", "the slow brown fox jumps");
  assert.deepEqual(parts, [
    { op: "equal", text: "the " },
    { op: "delete", text: "quick" },
    { op: "insert", text: "slow" },
    { op: "equal", text: " brown fox" },
    { op: "insert", text: " jumps" },
  ]);
  assert.deepEqual(diffWords("same", "same"), [{ op: "equal", text: "same" }]);
  assert.deepEqual(diffWords("", "new"), [{ op: "insert", text: "new" }]);
  const revised = "the slow brown fox jumps";
  const ranges = insertedRanges(parts);
  assert.deepEqual(ranges.map(([from, to]) => revised.slice(from, to)), ["slow", " jumps"]);
  // Joining equal and deleted parts always gives the base back, equal and inserted the revision.
  assert.equal(parts.filter((p) => p.op !== "insert").map((p) => p.text).join(""), "the quick brown fox");
  assert.equal(parts.filter((p) => p.op !== "delete").map((p) => p.text).join(""), revised);
});

test("a script compared with itself is identical", () => {
  const script = parseFountain(BASE);
  const result = compareScripts(script, structuredClone(script));
  assert.equal(result.identical, true);
  assert.equal(result.changes.length, 0);
  assert.ok(result.scenes.every((s) => s.status === "unchanged"));
  assert.equal(result.counts.paragraphs.unchanged, script.paragraphs.length);
});

test("Fountain re-imports with fresh IDs compare by text", () => {
  const result = compareScripts(parseFountain(BASE), parseFountain(REVISED));
  const kinds = result.changes.map((c) => [c.kind, c.revisedText ?? c.baseText]);
  assert.deepEqual(kinds, [
    ["changed", "Mara stirs a pot. The radio hums softly."],
    ["changed", "Dinner is almost ready, Tom."],
    ["added", "TOM"],
    ["added", "Seriously."],
    ["deleted", "INT. GARAGE - DAY"],
    ["deleted", "Boxes everywhere. Dust in the light."],
    ["added", "INT. ATTIC - NIGHT"],
    ["added", "New scene entirely."],
  ]);
  const changedAction = result.changes[0]!;
  assert.deepEqual(changedAction.words?.filter((p) => p.op !== "equal"), [{ op: "insert", text: " softly" }]);
  assert.deepEqual(result.scenes.map((s) => s.status), ["changed", "unchanged", "omitted", "added"]);
  assert.equal(result.scenes[2]!.baseHeading, "INT. GARAGE - DAY");
  assert.equal(result.scenes[3]!.revisedHeading, "INT. ATTIC - NIGHT");
  assert.deepEqual(result.counts.scenes, { added: 1, omitted: 1, changed: 1, moved: 0, unchanged: 1 });
  assert.equal(result.counts.paragraphs.added, 4);
  assert.equal(result.counts.paragraphs.deleted, 2);
  assert.equal(result.counts.paragraphs.changed, 2);
  assert.equal(result.counts.wordsAdded, 1 + 1 + 1 + 1 + 3 + 3);
  assert.equal(result.identical, false);
});

test("matches by paragraph ID when drafts share a document", () => {
  const base = parseFountain(BASE);
  const revised = structuredClone(base);
  // Rewrite a paragraph beyond recognition: the ID still ties the two together.
  const action = revised.paragraphs.find((p) => text(p).startsWith("Mara stirs"))!;
  action.runs = [{ text: "Completely different words appear here." }];
  const result = compareScripts(base, revised);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]!.kind, "changed");
  assert.equal(result.changes[0]!.baseId, action.id);
  assert.equal(result.changes[0]!.revisedId, action.id);
  assert.equal(result.scenes[0]!.status, "changed");
});

test("an element type change is a change without a word diff", () => {
  const base = parseFountain(BASE);
  const revised = structuredClone(base);
  const action = revised.paragraphs.find((p) => text(p).startsWith("Boxes"))!;
  action.type = "general";
  const result = compareScripts(base, revised);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]!.kind, "changed");
  assert.equal(result.changes[0]!.baseType, "action");
  assert.equal(result.changes[0]!.type, "general");
  assert.equal(result.changes[0]!.words, undefined);
});

function moveScene(script: Script, from: number, to: number): Script {
  const copy = structuredClone(script);
  const starts = copy.paragraphs.flatMap((p, i) => (p.type === "sceneHeading" ? [i] : []));
  const ends = [...starts.slice(1), copy.paragraphs.length];
  const scenes = starts.map((s, i) => copy.paragraphs.slice(s, ends[i]));
  const [moved] = scenes.splice(from, 1);
  scenes.splice(to, 0, moved!);
  copy.paragraphs = scenes.flat();
  return copy;
}

test("a moved scene is one scene move, not a delete plus an add", () => {
  const base = parseFountain(BASE);
  const revised = moveScene(base, 2, 0);
  const result = compareScripts(base, revised);
  assert.deepEqual(result.scenes.map((s) => s.status), ["moved", "unchanged", "unchanged"]);
  assert.equal(result.scenes[0]!.revisedHeading, "INT. GARAGE - DAY");
  assert.deepEqual(result.counts.scenes, { added: 0, omitted: 0, changed: 0, moved: 1, unchanged: 2 });
  assert.equal(result.counts.paragraphs.added + result.counts.paragraphs.deleted, 0);
  // Paragraphs that travelled with their scene are not paragraph moves.
  assert.equal(result.changes.length, 0);
  assert.equal(result.identical, false);
});

test("moves are found by text when there are no shared IDs", () => {
  const base = parseFountain(BASE);
  const revised = parseFountain(writeFountain(moveScene(base, 2, 0)));
  const result = compareScripts(base, revised);
  assert.equal(result.counts.paragraphs.added + result.counts.paragraphs.deleted, 0);
  assert.equal(result.counts.scenes.moved, 1);
  assert.equal(result.counts.scenes.omitted + result.counts.scenes.added, 0);
});

test("a paragraph moved to another scene is a move", () => {
  const base = parseFountain(BASE);
  const revised = structuredClone(base);
  const from = revised.paragraphs.findIndex((p) => text(p).startsWith("Boxes"));
  const [moved] = revised.paragraphs.splice(from, 1);
  const into = revised.paragraphs.findIndex((p) => text(p).startsWith("Tom sits"));
  revised.paragraphs.splice(into + 1, 0, moved!);
  const result = compareScripts(base, revised);
  assert.deepEqual(result.changes.map((c) => c.kind), ["moved"]);
  assert.equal(result.changes[0]!.baseSceneId !== result.changes[0]!.revisedSceneId, true);
  assert.deepEqual(result.scenes.map((s) => s.status), ["unchanged", "changed", "changed"]);
});

test("an edited and moved paragraph is a move with a word diff", () => {
  const base = parseFountain(`INT. A - DAY

Alpha one two three four five six.

Bravo bravo bravo bravo.

Charlie charlie charlie charlie.

Delta delta delta delta.
`);
  const revised = parseFountain(`INT. A - DAY

Bravo bravo bravo bravo.

Charlie charlie charlie charlie.

Delta delta delta delta.

Alpha one two three four five SEVEN.
`);
  const result = compareScripts(base, revised);
  assert.equal(result.changes.length, 1);
  const move = result.changes[0]!;
  assert.equal(move.kind, "moved");
  assert.ok(move.words?.some((p) => p.op === "insert" && p.text === "SEVEN"));
});

test("a scene whose heading was rewritten still matches when its content does", () => {
  const base = parseFountain(BASE);
  const revised = parseFountain(BASE.replace("EXT. YARD - NIGHT", "EXT. BACK YARD - LATE NIGHT"));
  const result = compareScripts(base, revised);
  assert.deepEqual(result.scenes.map((s) => s.status), ["unchanged", "changed", "unchanged"]);
  assert.equal(result.scenes[1]!.baseHeading, "EXT. YARD - NIGHT");
  assert.equal(result.scenes[1]!.revisedHeading, "EXT. BACK YARD - LATE NIGHT");
  assert.equal(result.counts.scenes.added + result.counts.scenes.omitted, 0);
});

test("an FDX round trip keeps IDs and compares as identical", () => {
  const base = parseFountain(BASE);
  const trip = parseFdx(writeFdx(base));
  assert.equal(compareScripts(base, trip).identical, true);
  const edited = structuredClone(trip);
  edited.paragraphs.find((p) => text(p).startsWith("Boxes"))!.runs = [{ text: "Boxes everywhere. Dust and a cat." }];
  const result = compareScripts(base, edited);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]!.baseId, base.paragraphs.find((p) => text(p).startsWith("Boxes"))!.id);
});

test("compares a ScreenplayDoc snapshot with edits made through the document", () => {
  const doc = ScreenplayDoc.fromScript(parseFountain(BASE));
  const base = doc.toScript();
  const target = base.paragraphs.find((p) => text(p).startsWith("TOM") === false && text(p).startsWith("I'm"))!;
  doc.insertText(target.id, text(target).length, " at all");
  const result = compareScripts(base, doc.toScript());
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0]!.words?.filter((p) => p.op === "insert"), [{ op: "insert", text: " at all" }]);
});

test("empty paragraphs and non-printing elements do not count", () => {
  const base = parseFountain("INT. A - DAY\n\nText.\n");
  const revised = structuredClone(base);
  revised.paragraphs.push({ id: "e", type: "action", runs: [] }, { id: "n", type: "note", runs: [{ text: "a note" }] });
  assert.equal(compareScripts(base, revised).identical, true);
});

test("a long script with many scattered edits compares quickly", () => {
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) lines.push(`INT. PLACE ${i} - DAY`, "", `Action number ${i} walks across the room slowly.`, "", "ALICE", `Line ${i} runs on.`, "");
  const base = parseFountain(lines.join("\n"));
  const revised = parseFountain(lines.map((l, i) => (i % 70 === 2 ? l.replace("slowly", "quickly") : l)).join("\n"));
  const started = performance.now();
  const result = compareScripts(base, revised);
  assert.ok(performance.now() - started < 3000);
  assert.equal(result.counts.paragraphs.changed, 40);
  assert.equal(result.counts.paragraphs.added + result.counts.paragraphs.deleted + result.counts.paragraphs.moved, 0);
  assert.equal(result.counts.scenes.changed, 40);
});

test("spacing-only differences are not changes", () => {
  const base = parseFountain("INT. KITCHEN - DAY\n\nMara stirs a pot.\n\nMARA\nHello there.\n");
  const spaced = structuredClone(base);
  spaced.paragraphs[1]!.runs = [{ text: "Mara  stirs a pot.   " }];
  spaced.paragraphs[3]!.runs = [{ text: " Hello there." }];
  assert.equal(compareScripts(base, spaced).identical, true);
});
