import assert from "node:assert/strict";
import test from "node:test";
import { type Paragraph, type PhoneProduction } from "@screenplay/engine";
import { revisionColor, revisionLines } from "../src/reader-revisions.ts";

const blue = { id: "1", name: "Blue", color: "#0000ff", mark: "+", date: "", style: "" };
const production: PhoneProduction = { v: 2, active: blue, sets: [blue], scenes: [], lockedPages: [],
  marks: { p: { label: "Blue", color: blue.color } } };

test("margin marks follow revised wrapped lines and use the revision set's mark", () => {
  const paragraph: Paragraph = { id: "p", type: "action", runs: [{ text: "Original. " },
    { text: "New words across two lines.", fdx: { RevisionID: "1" } }] };
  const lines = ["Original. ", "New words ", "across two lines."].map((text, i) => ({ text, y: i * 20, height: 20 }));
  assert.deepEqual(revisionLines(paragraph, lines, production), [
    { y: 20, height: 20, mark: "+", color: blue.color }, { y: 40, height: 20, mark: "+", color: blue.color },
  ]);
  assert.deepEqual(revisionLines(paragraph, lines), []);
  assert.deepEqual(revisionLines(paragraph, [], production), []);
});

test("deletions mark their line, including an empty paragraph, and old snapshots fall back to an asterisk", () => {
  const paragraph: Paragraph = { id: "p", type: "action", runs: [{ text: "" }],
    fdx: { after: [{ name: "DeletedTextLocation", attrs: [["Offset", "0"], ["RevisionID", "1"]], children: [] }] } };
  const lines = [{ text: "", y: 0, height: 20 }];
  assert.equal(revisionLines(paragraph, lines, production)[0]?.mark, "+");
  assert.equal(revisionLines(paragraph, lines, { ...production, sets: [] })[0]?.mark, "*");
  paragraph.runs = [{ text: "Before. After." }];
  paragraph.fdx!.after![0]!.attrs = [["Offset", "8"], ["RevisionID", "1"]];
  assert.deepEqual(revisionLines(paragraph, [{ text: "Before. ", y: 0, height: 20 }, { text: "After.", y: 20, height: 20 }], production),
    [{ y: 20, height: 20, mark: "+", color: blue.color }]);
});

test("dark mode lifts dark revision colors while retaining their hue", () => {
  assert.equal(revisionColor("#0000ff", false), "#0000ff");
  const adjusted = revisionColor("#0000ff", true);
  assert.notEqual(adjusted, "#0000ff");
  assert.equal(adjusted.slice(5), "ff");
  assert.equal(revisionColor("#abcdef", true), "#abcdef");
});
