import assert from "node:assert/strict";
import test from "node:test";
import { paginate, type Script } from "@screenplay/engine";
import { compactSides } from "../src/renderer/features/delivery/sides.ts";
const script: Script = { titlePage: [], paragraphs: [
  { id: "s1", sceneId: "first", type: "sceneHeading", sceneNumber: "12A", runs: [{ text: "INT. ROOM - DAY" }] },
  { id: "a1", type: "action", runs: [{ text: "A door closes.", bold: true }] },
  { id: "s2", sceneId: "second", type: "sceneHeading", sceneNumber: "13", startsNewPage: true, runs: [{ text: "EXT. ROAD - NIGHT" }] },
  { id: "a2", type: "action", runs: [{ text: "This scene is excluded." }] },
  { id: "s3", sceneId: "third", type: "sceneHeading", sceneNumber: "14B", startsNewPage: true, runs: [{ text: "INT. HALL - DAY" }] },
  { id: "a3", type: "action", runs: [{ text: "Only the bell answers." }] },
] };
test("compact sides repaginate selected scenes and retain source scene/page references without editing the master", () => {
  const before = structuredClone(script), original = paginate(script);
  assert.equal(original.pages.length, 3);
  const result = compactSides(script, original, new Set(["first", "third"]), { locks: [{ number: "20", paragraphId: "s3", offset: 0 }] });
  assert.equal(result.pagination.pages.length, 1);
  assert.deepEqual(result.sourcePages.get("1"), ["1", "3"]);
  assert.deepEqual(result.script.paragraphs.filter((p) => p.type === "sceneHeading").map((p) => p.sceneNumber), ["12A", "14B"]);
  assert(!result.script.paragraphs.some((p) => p.id === "a2"));
  assert.equal(result.script.paragraphs[1]?.runs[0]?.bold, true);
  assert.deepEqual(script, before);
});
test("a compact booklet gives previously unnumbered scenes their source ordinal only in its delivery copy", () => {
  const source = structuredClone(script);
  for (const p of source.paragraphs) delete p.sceneNumber;
  const result = compactSides(source, paginate(source), new Set(["third"]));
  assert.equal(result.script.paragraphs[0]?.sceneNumber, "3");
  assert(source.paragraphs.every((p) => p.sceneNumber === undefined));
});
test("no selected scenes produces no printable booklet content", () => {
  const result = compactSides(script, paginate(script), new Set());
  assert.equal(result.script.paragraphs.length, 0);
  assert(result.pagination.pages.every((p) => p.lines.length === 0));
});
