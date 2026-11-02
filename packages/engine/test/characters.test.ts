import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCharacterRegistry, characterEvidence, EvidenceCache, mergeIdentities, NARRATOR,
  type CharacterIdentity, type Script,
} from "../src/index.ts";
import { readRoles, reconcileCast } from "../src/read-plan.ts";

const p = (id: string, type: "sceneHeading" | "action" | "character" | "parenthetical" | "dialogue", text: string) => ({ id, type, runs: [{ text }] });

const script: Script = { titlePage: [], paragraphs: [
  p("s1", "sceneHeading", "INT. DINER - NIGHT"),
  p("a1", "action", "OLD NORA counts the register. A woman with a gravelly voice."),
  p("n1", "character", "OLD NORA"), p("n1d", "dialogue", "We close in five."),
  p("h1", "character", "MRS. HALE"), p("h1p", "parenthetical", "(quietly)"), p("h1d", "dialogue", "Leave the light on."),
  p("s2", "sceneHeading", "EXT. STREET - DAWN"),
  p("a2", "action", "NORA waits under the awning."),
  p("n2", "character", "NORA"), p("n2d", "dialogue", "You kept me waiting."),
  p("h2", "character", "HALE"), p("h2d", "dialogue", "I was closing up."),
] };

const identity = (id: string, displayName: string, aliases: string[] = [], cueIds: string[] = []): CharacterIdentity => ({ id, displayName, aliases, cueIds });

test("the registry keeps every cue name separate until the writer confirms an alias", () => {
  const registry = buildCharacterRegistry(script);
  assert.deepEqual(registry.characters.map((c) => c.displayName), ["OLD NORA", "MRS. HALE", "NORA", "HALE"]);
  assert.equal(registry.characters[0]!.id, "n1");
  assert.deepEqual(registry.characters.map((c) => c.cueIds), [["n1"], ["h1"], ["n2"], ["h2"]]);
  assert.equal(registry.narrator.id, NARRATOR);
  assert(!registry.characters.some((c) => c.id === NARRATOR));
  const pairs = registry.suggestions.map((s) => `${s.name}->${s.characterId}`);
  assert(pairs.includes("NORA->n1"));
  assert(pairs.includes("HALE->h1"));
  // Detection never merges: the cue names remain distinct identities.
  assert.equal(registry.characters.length, 4);
});

test("confirmed aliases group cues into one character without losing the old name", () => {
  const confirmed = [identity("n2", "NORA", ["OLD NORA"], ["n2"])];
  const registry = buildCharacterRegistry(script, confirmed);
  const nora = registry.characters.find((c) => c.id === "n2")!;
  assert.equal(nora.displayName, "NORA");
  assert.deepEqual(nora.aliases, ["OLD NORA"]);
  assert.deepEqual(nora.cueIds, ["n1", "n2"]);
  const roles = readRoles(script, confirmed);
  assert.equal(roles.filter((r) => r.id === "n2").length, 1);
  assert.equal(roles.find((r) => r.id === "n2")!.cueIds.length, 2);
  assert(registry.suggestions.every((s) => s.name !== "OLD NORA" && s.name !== "NORA"));
});

test("a rename keeps the durable ID, voice and lock and records the old name", () => {
  const stored = [identity("n1", "MAYA", [], ["n1"])];
  const renamed = { ...script, paragraphs: script.paragraphs.map((row) => row.id === "n1" ? { ...row, runs: [{ text: "MARIA (V.O.)" }] } : row) };
  const registry = buildCharacterRegistry(renamed, stored);
  const maria = registry.characters.find((c) => c.id === "n1")!;
  assert.equal(maria.displayName, "MARIA");
  assert.deepEqual(maria.aliases, ["MAYA"]);
  const roles = readRoles(renamed, registry.characters).filter((r) => r.id === "n1");
  const before = [{ id: "n1", name: "MAYA", aliases: [], cueIds: ["n1"], voices: { system: "Samantha" }, locked: true }];
  const after = reconcileCast(roles, before);
  assert.equal(after[0]!.id, "n1");
  assert.equal(after[0]!.voices.system, "Samantha");
  assert(after[0]!.locked);
  assert.equal(after[0]!.name, "MARIA");
});

test("merging two identities folds aliases and cue IDs into the kept character", () => {
  const registry = buildCharacterRegistry(script);
  const merged = mergeIdentities(registry.characters, "n1", "n2");
  const nora = merged.find((c) => c.id === "n2")!;
  assert.equal(nora.displayName, "NORA");
  assert.deepEqual(nora.aliases.sort(), ["OLD NORA"]);
  assert.deepEqual(nora.cueIds.sort(), ["n1", "n2"]);
  assert.equal(merged.length, 3);
});

test("evidence spans the whole script, not only the nearest scene", () => {
  const rows: Script["paragraphs"] = [p("s", "sceneHeading", "INT. ROOM - DAY"), p("c", "character", "MAYA")];
  for (let i = 0; i < 10; i++) {
    rows.push(p(`line${i}`, "dialogue", `Speech number ${i}.`));
    if (i < 9) rows.push(p(`s${i}`, "sceneHeading", `INT. ROOM ${i} - DAY`), p(`c${i}`, "character", "MAYA"));
  }
  const full: Script = { titlePage: [], paragraphs: rows };
  const maya = buildCharacterRegistry(full).characters[0]!;
  assert.equal(maya.cueIds.length, 10);
  const packet = characterEvidence(full, maya, { maxLines: 3 });
  assert.equal(packet.lineCount, 10);
  assert.equal(packet.sceneCount, 10);
  assert.equal(packet.lines.length, 3);
  assert.equal(packet.lines[0]!.paragraphId, "line0");
  assert.equal(packet.lines.at(-1)!.paragraphId, "line9");
  assert(packet.lines[1]!.paragraphId !== "line1");
  for (const line of packet.lines) assert(packet.anchors.includes(line.paragraphId));
});

test("evidence packets carry descriptions and parentheticals but stay bounded", () => {
  const packet = characterEvidence(script, identity("h1", "MRS. HALE", [], ["h1"]));
  assert.equal(packet.name, "MRS. HALE");
  assert.equal(packet.lineCount, 1);
  assert.equal(packet.descriptions.length, 0, "the action line does not name Mrs. Hale");
  assert.equal(packet.parentheticals[0]!.paragraphId, "h1p");
  const bounded = characterEvidence(script, identity("n1", "OLD NORA", [], ["n1"]), { maxChars: 12, maxLineChars: 40 });
  assert(bounded.truncated);
  const length = bounded.lines.reduce((sum, line) => sum + line.text.length, 0)
    + bounded.descriptions.reduce((sum, row) => sum + row.text.length, 0)
    + bounded.parentheticals.reduce((sum, row) => sum + row.text.length, 0);
  assert(length <= 12);
});

test("an evidence fingerprint ignores nothing the character says", () => {
  const maya = identity("c", "MAYA", [], ["c"]);
  const one: Script = { titlePage: [], paragraphs: [p("s", "sceneHeading", "INT. ROOM - DAY"), p("c", "character", "MAYA"), p("d1", "dialogue", "First line."), p("d2", "dialogue", "Second line.")] };
  const two = { ...one, paragraphs: one.paragraphs.map((row) => row.id === "d2" ? { ...row, runs: [{ text: "Changed line." }] } : row) };
  const first = characterEvidence(one, maya, { maxLines: 1 });
  const second = characterEvidence(two, maya, { maxLines: 1 });
  assert.equal(first.lines[0]!.text, "First line.");
  assert.equal(second.lines[0]!.text, "First line.");
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("the packet cache reuses unchanged characters and rebuilds changed ones", () => {
  const maya = identity("c", "MAYA", [], ["c"]);
  const eli = identity("e", "ELI", [], ["e"]);
  const one: Script = { titlePage: [], paragraphs: [
    p("s", "sceneHeading", "INT. ROOM - DAY"), p("c", "character", "MAYA"), p("cd", "dialogue", "Stay."), p("e", "character", "ELI"), p("ed", "dialogue", "No."),
  ] };
  const cache = new EvidenceCache();
  const first = cache.build(one, [maya, eli]);
  assert.deepEqual(first.reused, []);
  const second = cache.build(one, [maya, eli]);
  assert.deepEqual(second.reused, ["c", "e"]);
  assert.equal(second.packets[0], first.packets[0]);
  const edited = { ...one, paragraphs: one.paragraphs.map((row) => row.id === "ed" ? { ...row, runs: [{ text: "Never." }] } : row) };
  const third = cache.build(edited, [maya, eli]);
  assert.deepEqual(third.reused, ["c"]);
  assert.notEqual(third.packets[1]!.fingerprint, first.packets[1]!.fingerprint);
});
