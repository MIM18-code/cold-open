import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown, spans } from "../src/renderer/features/assistant/markdown.ts";

test("a model's continuity table becomes a table with bold cells, not raw pipes", () => {
  const blocks = parseMarkdown([
    "| Issue | Scenes | Discrepancy |",
    "|---|---|---|",
    "| **Ruth's cast disappears** | Scene 1; Scene 5 | Her left arm is in a \"fresh white cast\". |",
    "| **Revolver changes bins** | Scene 3; Scene 7 | Flour bin, then **sugar bin**. |",
    "",
    "I found no clear contradictions in names.",
  ].join("\n"));
  assert.equal(blocks.length, 2);
  const table = blocks[0]!;
  assert.equal(table.type, "table");
  if (table.type !== "table") return;
  assert.deepEqual(table.header.map((cell) => cell[0]!.text), ["Issue", "Scenes", "Discrepancy"]);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0]![0], [{ text: "Ruth's cast disappears", bold: true }]);
  assert.deepEqual(table.rows[1]![2], [{ text: "Flour bin, then " }, { text: "sugar bin", bold: true }, { text: "." }]);
  assert.deepEqual(blocks[1], { type: "paragraph", spans: [{ text: "I found no clear contradictions in names." }] });
});

test("lists, headings and inline marks", () => {
  const blocks = parseMarkdown("## Issues\n- First *one*\n- Second `code`\n\n1. Ordered\n2. Next\n\n---\nEnd");
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "list", "list", "paragraph"]);
  assert.deepEqual(blocks[1], { type: "list", ordered: false, items: [[{ text: "First " }, { text: "one", italic: true }], [{ text: "Second " }, { text: "code", code: true }]] });
  assert.equal(blocks[2]!.type === "list" && blocks[2]!.ordered, true);
});

test("plain text, underscores in words and markup-looking text stay as text", () => {
  assert.deepEqual(spans("snake_case_name stays"), [{ text: "snake_case_name stays" }]);
  assert.deepEqual(spans("2 * 3 * 4"), [{ text: "2 * 3 * 4" }]);
  assert.deepEqual(parseMarkdown("<script>alert(1)</script>"), [{ type: "paragraph", spans: [{ text: "<script>alert(1)</script>" }] }]);
  assert.deepEqual(parseMarkdown("Line one\nline two"), [{ type: "paragraph", spans: [{ text: "Line one\nline two" }] }]);
  assert.deepEqual(parseMarkdown("| not | a table |"), [{ type: "paragraph", spans: [{ text: "| not | a table |" }] }]);
});

test("hostile or literal text keeps its meaning and parses fast", () => {
  const started = performance.now();
  parseMarkdown(`| a | b |\n|${" ".repeat(5000)}--${" ".repeat(5000)}x\n`);
  parseMarkdown(`| a |${" ".repeat(20000)}`);
  assert.ok(performance.now() - started < 200, "a long run of spaces must not freeze the panel");
  assert.deepEqual(spans("2*3*4 and _private_field"), [{ text: "2*3*4 and _private_field" }]);
  assert.deepEqual(spans("a *real* word"), [{ text: "a " }, { text: "real", italic: true }, { text: " word" }]);
  const table = parseMarkdown("| Scene | Line |\n|---|---|\n| left \\| right | 7 |")[0]!;
  assert.equal(table.type === "table" && table.rows[0]!.length, 2);
  assert.equal(table.type === "table" && table.rows[0]![0]![0]!.text, "left | right");
  assert.deepEqual(parseMarkdown("```fountain\n# Act II\nINT. DINER - NIGHT\n```"), [{ type: "code", text: "# Act II\nINT. DINER - NIGHT" }]);
  assert.deepEqual(parseMarkdown("7. Seventh\n8. Eighth")[0], { type: "list", ordered: true, start: 7, items: [[{ text: "Seventh" }], [{ text: "Eighth" }]] });
});

test("edge cases: a rejected marker, backslash parity, long fences and lists split by a rule", () => {
  assert.deepEqual(spans("x*y *real* word"), [{ text: "x*y " }, { text: "real", italic: true }, { text: " word" }]);
  const table = parseMarkdown("| Path | N |\n|---|---|\n| C:\\\\| 7 |")[0]!;
  assert.equal(table.type === "table" && table.rows[0]!.map((cell) => cell[0]?.text).join(","), "C:\\,7");
  assert.deepEqual(parseMarkdown("````\n```\n# Act II\n````\nAfter"), [{ type: "code", text: "```\n# Act II" }, { type: "paragraph", spans: [{ text: "After" }] }]);
  const lists = parseMarkdown("7. Seven\n\n---\n\n1. One");
  assert.equal(lists.length, 2);
  assert.equal(lists[1]!.type === "list" && lists[1]!.start, undefined);
});
