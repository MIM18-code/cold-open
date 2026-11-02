import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCharacterRegistry, parseFountain, plainText, type Script } from "@screenplay/engine";
import { executeTool, scriptTools, type ToolContext } from "../src/renderer/features/assistant/tools.ts";
import { assistantSystem, buildScriptContext, selectedText } from "../src/renderer/features/assistant/context.ts";
import { locate } from "../src/renderer/features/assistant/suggestions.ts";

const sample = (): Script => parseFountain([
  "INT. OFFICE - DAY #12#", "", "Nell holds a gun.", "", "NELL", "The gun is empty.", "",
  "NELL (V.O.)", "Don't move.", "", "EXT. ROAD - NIGHT #12A#", "", "The car waits.", "",
  "RAY", "Get in.", "", "NELL", "Wait.", "", "INT. CAR - NIGHT", "", "The gun lies on the seat.", "",
].join("\n"));

function tool(name: string, args: Record<string, unknown> = {}, script = sample(), extra: Partial<ToolContext> = {}) {
  return executeTool({ id: "call-1", name, arguments: args }, { script: () => script, ...extra });
}

test("tools list scenes with numbers, ordinals, pages and speaking characters", async () => {
  const output = await tool("list_scenes");
  const scenes = output.result as { number: string; ordinal: number; heading: string; page: string; characters: string[] }[];
  assert.equal(scenes.length, 3);
  assert.deepEqual(scenes.map((scene) => scene.number), ["12", "12A", "3"]);
  assert.deepEqual(scenes.map((scene) => scene.ordinal), [1, 2, 3]);
  assert.deepEqual(scenes[1]!.characters, ["RAY", "NELL"]);
  assert.equal(scenes[0]!.page, "1");
  assert.equal(output.line, "Listed 3 scenes");
});

test("tools read a scene by number or ordinal, and reject a missing or duplicated scene", async () => {
  const byNumber = await tool("read_scene", { scene: "12A" });
  const byOrdinal = await tool("read_scene", { scene: 2 });
  assert.deepEqual(byOrdinal.result, byNumber.result);
  assert.match(JSON.stringify(byNumber.result), /Get in\./);
  assert.doesNotMatch(JSON.stringify(byNumber.result), /gun/);
  assert.match(byNumber.line, /Read Scene 12A \(EXT\. ROAD - NIGHT\)/);
  assert.match(JSON.stringify((await tool("read_scene", { scene: "500" })).result), /does not exist/);
  const s = sample(); s.paragraphs.find((p) => p.sceneNumber === "12A")!.sceneNumber = "12";
  assert.match(JSON.stringify((await tool("read_scene", { scene: "12" }, s)).result), /duplicated/);
});

test("tools search case-insensitively and cap matches at 30", async () => {
  const output = await tool("search_script", { query: "GUN" });
  assert.equal((output.result as { matches: unknown[] }).matches.length, 3);
  assert.match(output.line, /3 matches/);
  const limited = await tool("search_script", { query: "gun", limit: 1 });
  assert.equal((limited.result as { matches: unknown[] }).matches.length, 1);
  const s = sample();
  s.paragraphs.push({ id: "many", type: "action", runs: [{ text: Array.from({ length: 40 }, () => "gun").join("\n") }] });
  assert.equal(((await tool("search_script", { query: "gun" }, s)).result as { matches: unknown[] }).matches.length, 30);
  assert.match(JSON.stringify((await tool("search_script", { query: "" })).result), /empty/);
});

test("tools character uses the registry, cue extensions and confirmed aliases", async () => {
  const s = sample();
  const identity = buildCharacterRegistry(s).characters.find((character) => character.displayName === "NELL")!;
  identity.aliases = ["ELEANOR"];
  const output = await tool("character", { name: "eleanor" }, s, { identities: () => [identity] });
  const result = output.result as { aliases: string[]; lineCount: number; scenes: string[]; firstAppearance: { scene: string; line: string } };
  assert.deepEqual(result.aliases, ["ELEANOR"]);
  assert.equal(result.lineCount, 3);
  assert.equal(result.scenes.length, 2);
  assert.deepEqual(result.firstAppearance, { scene: "Scene 12 (INT. OFFICE - DAY)", line: "Nell holds a gun." });
  assert.match(JSON.stringify((await tool("character", { name: "Nobody" })).result), /No speaking character/);
});

test("tools propose an exact, applicable edit without changing the script", async () => {
  const s = sample(), before = structuredClone(s);
  const output = await tool("propose_edit", { scene: "1", find: "Nell holds a gun.", replace: "Nell hides a gun.", why: "Keep the gun hidden." }, s);
  assert.equal((output.result as { ok: boolean }).ok, true);
  assert.equal(output.proposal!.scene, "12");
  assert.ok(!("error" in locate(s, output.proposal!)));
  assert.deepEqual(s, before);
  s.paragraphs.find((p) => plainText(p.runs) === "Nell holds a gun.")!.runs = [{ text: "Nell leaves." }];
  assert.ok("error" in locate(s, output.proposal!), "Apply rechecks the live script");
});

test("tools reject missing, ambiguous, unchanged, cross-paragraph and wrong-scene edits", async () => {
  const args = { scene: "12", find: "missing", replace: "replacement", why: "Continuity." };
  for (const [change, expected] of [
    [{}, /not in the script/], [{ find: "gun" }, /appears 2 times/], [{ find: "NELL" }, /appears 2 times/],
    [{ find: "Nell holds a gun.", replace: "Nell holds a gun." }, /identical/],
    [{ find: "" }, /empty/], [{ scene: "12A", find: "Nell holds a gun." }, /no longer in scene 12A/],
    [{ scene: "999" }, /does not exist/], [{ find: "NELL\nThe gun is empty." }, /one paragraph/],
  ] as [Record<string, unknown>, RegExp][]) {
    const output = await tool("propose_edit", { ...args, ...change });
    assert.match(JSON.stringify(output.result), expected);
    assert.equal(output.proposal, undefined);
  }
});

test("tools validate required arguments and optional search limits", async () => {
  for (const [name, args] of [["read_scene", {}], ["search_script", { query: "gun", limit: 31 }],
    ["search_script", { query: 1 }], ["list_scenes", { path: "/private/script" }], ["not_a_tool", {}]] as [string, Record<string, unknown>][]) {
    assert.equal(((await tool(name, args)).result as { ok: boolean }).ok, false);
  }
});

test("production data is offered only when enabled and returns the main-process summary", async () => {
  assert.ok(!scriptTools(false).some((tool) => tool.name === "production_data"));
  assert.ok(scriptTools(true).some((tool) => tool.name === "production_data"));
  assert.equal(((await tool("production_data")).result as { ok: boolean }).ok, false);
  const result = await tool("production_data", {}, sample(), { productionData: async () => ({ ok: true, text: "Scene 12: prop gun, day 2" }) });
  assert.deepEqual(result.result, { ok: true, text: "Scene 12: prop gun, day 2" });
});

test("inline and standalone notes never enter any tool, context or selection", async () => {
  const s = sample();
  for (const paragraph of s.paragraphs) paragraph.runs.push({ text: "PRIVATE NOTE", note: true });
  s.paragraphs.push({ id: "note", type: "note", runs: [{ text: "PRIVATE NOTE" }] });
  for (const [name, args] of [["list_scenes", {}], ["read_scene", { scene: "12" }],
    ["search_script", { query: "gun" }], ["character", { name: "Nell" }],
    ["propose_edit", { scene: "12", find: "Nell holds a gun.", replace: "Nell hides it.", why: "Continuity." }]] as [string, Record<string, unknown>][]) {
    assert.doesNotMatch(JSON.stringify((await tool(name, args, s)).result), /PRIVATE NOTE/);
  }
  assert.deepEqual(((await tool("search_script", { query: "PRIVATE NOTE" }, s)).result as { matches: unknown[] }).matches, []);
  assert.equal((await tool("propose_edit", { scene: "12", find: "PRIVATE NOTE", replace: "public", why: "" }, s)).proposal, undefined);
  const context = buildScriptContext(s, null, 1e6);
  assert.doesNotMatch(assistantSystem({ context }), /PRIVATE NOTE/);
  const selected = selectedText(s, { paragraphId: s.paragraphs[0]!.id, offset: 0 }, { paragraphId: s.paragraphs.at(-1)!.id, offset: 1000 });
  assert.doesNotMatch(selected, /PRIVATE NOTE/);
});

test("each tool reads the current document rather than retaining a snapshot", async () => {
  let current = sample();
  const context: ToolContext = { script: () => current };
  const call = { id: "c", name: "search_script", arguments: { query: "gun" } };
  assert.equal(((await executeTool(call, context)).result as { matches: unknown[] }).matches.length, 3);
  current = parseFountain("INT. EMPTY - DAY\n\nNothing here.\n");
  assert.equal(((await executeTool(call, context)).result as { matches: unknown[] }).matches.length, 0);
});

test("a proposal matches what the writer sees: never text inside a private note, and bold or italic words as plain text", async () => {
  const { locate } = await import("../src/renderer/features/assistant/suggestions.ts");
  const script = { titlePage: [], paragraphs: [
    { id: "h", type: "sceneHeading" as const, sceneId: "s", runs: [{ text: "INT. ROOM - DAY" }] },
    { id: "a", type: "action" as const, runs: [{ text: "Nell " }, { text: "Nell leaves.", note: true as const }, { text: "leaves." }] },
    { id: "b", type: "action" as const, runs: [{ text: "Nell " }, { text: "holds", bold: true as const }, { text: " a gun." }] },
  ] };
  // The note holds the same sentence; the visible passage has the note inside it, so it is left to the writer.
  assert.match(JSON.stringify(locate(script, { scene: "1", find: "Nell leaves.", replace: "Nell runs." })), /private note inside it/);
  // Formatting is not part of the text to match, and the range covers the formatted run.
  assert.deepEqual(locate(script, { scene: "1", find: "Nell holds a gun.", replace: "Nell drops the gun." }), { paragraphId: "b", from: 0, to: 17 });
  assert.ok("error" in locate(script, { scene: "1", find: "Nell **holds** a gun.", replace: "x" }));
});

test("standalone notes are never an edit target, alone or duplicating visible text", async () => {
  const { locate } = await import("../src/renderer/features/assistant/suggestions.ts");
  const script = { titlePage: [], paragraphs: [
    { id: "h", type: "sceneHeading" as const, sceneId: "s", runs: [{ text: "INT. ROOM - DAY" }] },
    { id: "n", type: "note" as const, runs: [{ text: "Cut the gun." }] },
    { id: "a", type: "action" as const, runs: [{ text: "Nell holds a gun." }] },
    { id: "n2", type: "note" as const, runs: [{ text: "Nell holds a gun." }] },
  ] };
  assert.ok("error" in locate(script, { scene: "1", find: "Cut the gun.", replace: "x" }));
  assert.deepEqual(locate(script, { scene: "1", find: "Nell holds a gun.", replace: "Nell drops it." }), { paragraphId: "a", from: 0, to: 17 });
});
