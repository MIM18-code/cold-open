// Layout rules measured on Final Draft 13's own PDFs (see pagination-corpus.ts), on synthetic text.
import assert from "node:assert/strict";
import { test } from "node:test";

import { paginate, wrap, type Line, type Paragraph } from "../src/index.ts";

const text = (line: Line) => line.runs.map((run) => run.text).join("");

test("a hyphen just past the margin hangs there and ends the line", () => {
  // 60 characters, then a hyphenated word whose hyphen lands in column 62.
  const line = `${"x".repeat(55)} abcde-fghij more`;
  assert.deepEqual(wrap(line, 61).map(([from, to]) => line.slice(from, to)), [`${"x".repeat(55)} abcde-`, "fghij more"]);
  // A double hyphen ending a word hangs too; a hyphen after a space does not.
  const dashes = `${"y".repeat(32)}ab-- cd`;
  assert.deepEqual(wrap(dashes, 35).map(([from, to]) => dashes.slice(from, to)), [`${"y".repeat(32)}ab--`, "cd"]);
  const spaced = `${"z".repeat(34)} - next`;
  assert.deepEqual(wrap(spaced, 35).map(([from, to]) => spaced.slice(from, to)), ["z".repeat(34), "- next"]);
});

test("a line with a character Courier Final Draft lacks is 16 points tall", () => {
  const paragraphs: Paragraph[] = [
    { id: "a", type: "action", runs: [{ text: "It costs 5 € now." }] },
    { id: "b", type: "action", runs: [{ text: "Plain." }] },
  ];
  const lines = paginate({ titlePage: [], paragraphs }).pages[0]!.lines;
  assert.equal(lines[0]!.y, 0);
  assert.ok(Math.abs(lines[1]!.y - (16 / 12 + 1)) < 1e-9, "the next paragraph starts a third of a line lower");
});

test("dual dialogue columns wrap at 29 characters; the right one starts at 4.61 inches", () => {
  const words = "abcd efgh ijkl mnop qrst uvwx yzab cdef ghij";
  const paragraphs: Paragraph[] = [
    { id: "c1", type: "character", runs: [{ text: "ANNA" }], dual: { block: "b", side: 1 } },
    { id: "d1", type: "dialogue", runs: [{ text: words }], dual: { block: "b", side: 1 } },
    { id: "c2", type: "character", runs: [{ text: "BOB" }], dual: { block: "b", side: 2 } },
    { id: "d2", type: "dialogue", runs: [{ text: words }], dual: { block: "b", side: 2 } },
  ];
  const lines = paginate({ titlePage: [], paragraphs }).pages[0]!.lines;
  const left = lines.filter((line) => line.paragraphId === "d1"), right = lines.filter((line) => line.paragraphId === "d2");
  assert.deepEqual(left.map(text), ["abcd efgh ijkl mnop qrst uvwx", "yzab cdef ghij"]);
  assert.deepEqual(right.map(text), left.map(text));
  assert.equal(left[0]!.x, 1.5);
  assert.ok(Math.abs(right[0]!.x - 4.611) < 1e-9);
});
