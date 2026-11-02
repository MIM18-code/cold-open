import test from "node:test";
import assert from "node:assert/strict";
import { paginate, wrap } from "../src/index.ts";

test("wide CJK characters fill two columns and lines break between them", () => {
  const line = "こんにちは、元気ですか。日本語のテストです。";
  const ranges = wrap(line, 35);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0]![1] - ranges[0]![0], 17);
  assert.equal(ranges.map(([a, b]) => line.slice(a, b)).join(""), line);
});

test("text without wide characters wraps exactly as before", () => {
  const line = "He lowers his fork. The camera begins a slow zoom into a closeup of his face.";
  assert.deepEqual(wrap(line, 35), [[0, 30], [31, 64], [65, 77]]);
  assert.equal(wrap("Emoji 🎬 and text that runs on past the margin", 20).length, 3);
});

test("wide wrapping never splits an emoji or a kana from its combining mark", () => {
  const slices = (text: string, width: number) => wrap(text, width).map(([a, b]) => text.slice(a, b));
  assert.deepEqual(slices("你abcd🎬", 5), ["你", "abcd", "🎬"]);
  for (const piece of slices("你" + "a".repeat(34) + "🎬", 35)) assert.doesNotMatch(piece, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  assert.deepEqual(slices("か\u3099", 2), ["か\u3099"]);
  assert.equal(wrap("が".normalize("NFD").repeat(9), 18).length, 1);
  assert.deepEqual(slices("你👩🏽x", 2), ["你", "👩🏽", "x"]);
  for (const [text, width] of [["你ab-\u0301c", 4], ["你ab-\u0301cdef", 6]] as const) assert(slices(text, width).every(piece => !/^\u0301/.test(piece)));
});

test("emoji presentation of BMP symbols gets the tall line", () => {
  const script = { titlePage: [], paragraphs: [{ id: "c", type: "character" as const, runs: [{ text: "A" }] }, { id: "d", type: "dialogue" as const, runs: [{ text: "❤️\nnext" }] }] };
  const lines = paginate(script).pages.flatMap(p => p.lines).filter(l => l.paragraphId === "d");
  assert.equal(lines[0]!.tall, true);
});

test("CJK lines never start with closing punctuation or end with an opening bracket", () => {
  const slices = (text: string, width: number) => wrap(text, width).map(([a, b]) => text.slice(a, b));
  const japanese = "こんにちは世界。これは長い台詞です。文字が正しく折り返されるか確認します。今日はとても良い日ですね。";
  for (const width of [10, 20, 34, 35]) for (const line of slices(japanese, width)) assert.doesNotMatch(line, /^[、。」）]/);
  for (const line of slices("彼は「こんにちは」と言った。それから「さようなら」と言った。", 10)) assert.doesNotMatch(line, /「$/);
});
