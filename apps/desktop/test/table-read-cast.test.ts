import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCharacterRegistry, characterEvidence, NARRATOR,
  type CastBinding, type CharacterIdentity, type Script,
} from "@screenplay/engine";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { ScreenplayDoc } from "@screenplay/engine";
import * as Y from "yjs";
import {
  castForScript, fillCast, parseCast, parseCastProposal, requestCastProposal, voiceMap,
  CastingProposalError, castingRequest, CAST_PROPOSAL_SCHEMA, type ProposalContext,
} from "../src/renderer/features/table-read/casting.ts";
import {
  LEGACY_CAST_KEY, ignoreAlias, mergeStoredCharacters, readStoredCast, writeCast, writeCastState,
  type StoredCharacter,
} from "../src/renderer/features/table-read/cast-store.ts";
import { assignEnsemble, auditionChoices, recastCharacter, subjectFromPacket, voiceInfos, type VoiceInfo } from "../src/renderer/features/table-read/cast-ensemble.ts";

const p = (id: string, type: "sceneHeading" | "action" | "character" | "parenthetical" | "dialogue", text: string) => ({ id, type, runs: [{ text }] });
const SCRIPT: Script = { titlePage: [], paragraphs: [
  p("s1", "sceneHeading", "INT. DINER - NIGHT"),
  p("m1", "character", "MAYA"), p("md", "dialogue", "The door was open."),
  p("e1", "character", "ELI"), p("ed", "dialogue", "Then we close it."),
  p("s2", "sceneHeading", "EXT. ALLEY - DAWN"),
  p("m2", "character", "MAYA"), p("md2", "dialogue", "Too late for that."),
] };

const row = (id: string, name: string, voice: string, locked = false, aliases: string[] = []): StoredCharacter => ({
  id, name, aliases, locked, voices: { system: voice },
});
const inventory = [
  { id: "Samantha", label: "Samantha", language: "en-US" },
  { id: "Daniel", label: "Daniel", language: "en-GB" },
  { id: "Moira", label: "Moira", language: "en-IE" },
];

function sessionPair(legacy?: unknown) {
  const base = ScreenplayDoc.fromScript(SCRIPT);
  if (legacy) base.meta.set(LEGACY_CAST_KEY, legacy);
  const a = new DocumentSession(ScreenplayDoc.fromUpdate(base.encodeState()));
  const b = new DocumentSession(ScreenplayDoc.fromUpdate(base.encodeState()));
  a.undo.clear(); b.undo.clear();
  const sessions = [a, b], queues = [[], []] as Uint8Array[][];
  const net = "net";
  sessions.forEach((session, index) => session.doc.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== net) queues[index === 0 ? 1 : 0]!.push(update);
  }));
  const deliver = () => {
    for (let round = 0; round < 4; round++) sessions.forEach((session, index) => {
      for (const update of queues[index]!.splice(0)) session.doc.applyUpdate(update, net);
    });
  };
  return { a, b, deliver };
}

test("legacy cast blobs remain readable while only edited rows migrate", () => {
  const doc = ScreenplayDoc.fromScript(SCRIPT);
  doc.meta.set(LEGACY_CAST_KEY, { version: 1, cast: [{ id: "m1", name: "MAYA", cueIds: ["m1"], voices: { system: "Samantha" }, locked: true }], narrator: { system: "Daniel" } });
  const legacy = readStoredCast(doc);
  assert.equal(legacy.characters[0]!.voices.system, "Samantha");
  assert.equal(legacy.narrator.system, "Daniel");
  assert.equal(doc.meta.get(LEGACY_CAST_KEY) !== undefined, true);
  const session = new DocumentSession(doc);
  writeCast(session, { characters: [row("e1", "ELI", "Moira")] });
  assert.notEqual(doc.meta.get(LEGACY_CAST_KEY), undefined);
  assert(![...doc.meta.keys()].some((key) => key.startsWith("tableRead.cast.v3.character.")
    && key.includes('"m1"')), "an unedited legacy character is not migrated");
  const stored = readStoredCast(doc);
  assert.deepEqual(stored.characters.map((c) => c.id).sort(), ["e1", "m1"]);
  assert.equal(stored.characters.find((c) => c.id === "m1")!.voices.system, "Samantha");
  assert.equal(stored.narrator.system, "Daniel");
});

test("two writers changing different characters both keep their edits", () => {
  const { a, b, deliver } = sessionPair();
  assert.equal(writeCast(a, { characters: [row("m1", "MAYA", "Samantha", true)] }), true);
  assert.equal(writeCast(b, { characters: [row("e1", "ELI", "Moira")] }), true);
  deliver();
  for (const session of [a, b]) {
    const stored = readStoredCast(session.doc);
    assert.deepEqual(stored.characters.map((c) => c.id).sort(), ["e1", "m1"]);
    assert.equal(stored.characters.find((c) => c.id === "m1")!.voices.system, "Samantha");
    assert.equal(stored.characters.find((c) => c.id === "e1")!.voices.system, "Moira");
    assert.equal(stored.characters.find((c) => c.id === "m1")!.locked, true);
  }
});

test("two writers changing different engines of one character also merge", () => {
  const { a, b, deliver } = sessionPair();
  writeCast(a, { characters: [row("m1", "MAYA", "Samantha")] });
  deliver();
  writeCast(a, { characters: [{ ...row("m1", "MAYA", ""), voices: { system: "Samantha" } }] });
  writeCast(b, { characters: [{ ...row("m1", "MAYA", ""), voices: { phonon: "UK_George" } }] });
  deliver();
  const stored = readStoredCast(a.doc).characters.find((c) => c.id === "m1")!;
  assert.deepEqual(stored.voices, { phonon: "UK_George", system: "Samantha" });
});

test("read-only sessions never write or migrate", () => {
  const doc = ScreenplayDoc.fromScript(SCRIPT);
  doc.meta.set(LEGACY_CAST_KEY, { version: 1, cast: [{ id: "m1", name: "MAYA", cueIds: ["m1"], voices: { system: "Samantha" }, locked: false }] });
  const session = new DocumentSession(doc);
  session.setReadOnly(true);
  assert.equal(writeCast(session, { characters: [row("e1", "ELI", "Moira")] }), false);
  assert.equal(ignoreAlias(session, "m1", "MAYA HALE"), false);
  assert.equal(mergeStoredCharacters(session, "m1", "e1"), false);
  assert.equal(doc.meta.get(LEGACY_CAST_KEY) !== undefined, true);
  assert.deepEqual(readStoredCast(doc).characters.map((c) => c.id), ["m1"]);
});

test("confirmed aliases keep the voice map and rename-safe identity", () => {
  const aliased: Script = { titlePage: [], paragraphs: [
    p("s", "sceneHeading", "INT. DINER - NIGHT"),
    p("old", "character", "OLD NORA"), p("oldd", "dialogue", "We are closed."),
    p("n", "character", "NORA"), p("nd", "dialogue", "I know."),
  ] };
  const confirmed: CharacterIdentity[] = [{ id: "n", displayName: "NORA", aliases: ["OLD NORA"], cueIds: [] }];
  const view = castForScript(aliased, { characters: [{ id: "n", name: "NORA", aliases: ["OLD NORA"], locked: false, voices: { system: "Daniel" } }] });
  assert.equal(view.state.cast.length, 1);
  assert.equal(view.state.cast[0]!.voices.system, "Daniel");
  const map = voiceMap(view.state, "system");
  assert.equal(map["NORA"], "Daniel");
  assert.equal(map["OLD NORA"], "Daniel");
  assert.equal(buildCharacterRegistry(aliased, confirmed).characters.length, 1);
});

test("merging stored characters keeps the target voice, aliases and lock", () => {
  const session = new DocumentSession(ScreenplayDoc.fromScript(SCRIPT));
  writeCast(session, { characters: [row("m1", "MAYA", "Samantha", false, ["MARIA"]), { ...row("e1", "ELI", "Moira", true), voices: { system: "Moira", phonon: "UK_George" } }] });
  assert.equal(mergeStoredCharacters(session, "e1", "m1"), true);
  const stored = readStoredCast(session.doc);
  assert.deepEqual(stored.characters.map((c) => c.id), ["m1"]);
  const merged = stored.characters[0]!;
  assert.equal(merged.voices.system, "Samantha");
  assert.equal(merged.voices.phonon, "UK_George");
  assert(merged.locked);
  assert.deepEqual(merged.aliases.sort(), ["ELI", "MARIA"]);
});

test("confirming an alias before any other cast write still merges the visible rows", () => {
  const session = new DocumentSession(ScreenplayDoc.fromScript(SCRIPT));
  const known = [row("m1", "DETECTIVE MAYA", ""), row("m2", "MAYA", "")];
  assert.equal(mergeStoredCharacters(session, "m2", "m1", known), true);
  const stored = readStoredCast(session.doc);
  assert.deepEqual(stored.characters.map((c) => c.id), ["m1"]);
  assert.deepEqual(stored.characters[0]!.aliases, ["MAYA"]);
});

test("ignored alias pairs stop being suggestions without touching the names", () => {
  const session = new DocumentSession(ScreenplayDoc.fromScript(SCRIPT));
  assert.equal(ignoreAlias(session, "m1", "OLD NORA"), true);
  const stored = readStoredCast(session.doc);
  assert.deepEqual(stored.ignoredAliases, [JSON.stringify(["m1", "OLD NORA"])]);
  assert.equal(stored.characters.length, 0);
});

// ---------- proposals ----------

function proposalFixture() {
  const registry = buildCharacterRegistry(SCRIPT);
  const state = fillCast(castForScript(SCRIPT, {}).state, "system", inventory);
  const packets = registry.characters.map((identity) => characterEvidence(SCRIPT, identity, { maxLines: 2 }));
  const context: ProposalContext = { cast: state.cast, inventory, packets };
  return { state, packets, context };
}

test("rows with unknown IDs, locked roles or uninstalled voices are dropped, and a proposal with none left is rejected", () => {
  const { state, context } = proposalFixture();
  assert.equal(CAST_PROPOSAL_SCHEMA.properties.assignments.items.properties.reason.maxLength, 300);
  const valid = { assignments: [{ id: state.cast[0]!.id, voice: "Samantha", gender: "unclear", reason: "Low and plain.", evidence: [context.packets[0]!.anchors[0]!] }] };
  assert.equal(parseCastProposal(JSON.stringify(valid), context)[0]!.voice, "Samantha");
  const id = state.cast[0]!.id, anchor = context.packets[0]!.anchors[0]!;
  assert.throws(() => parseCastProposal(JSON.stringify({ assignments: [{ id: "nobody", voice: "Samantha", evidence: [anchor] }] }), context), /unknown or locked/);
  assert.throws(() => parseCastProposal(JSON.stringify({ assignments: [{ id, voice: "Invented", evidence: [anchor] }] }), context), /not installed/);
  // Paragraph citations are no longer asked for; one the model adds anyway is ignored.
  assert.equal(parseCastProposal(JSON.stringify({ assignments: [{ id, voice: "Samantha", gender: "unclear", evidence: ["missing"] }] }), context)[0]!.voice, "Samantha");
  const mixed = parseCastProposal(JSON.stringify({ assignments: [{ id: "nobody", voice: "Samantha", gender: "unclear", evidence: [anchor] }, valid.assignments[0]] }), context);
  assert.deepEqual(mixed.map((row) => row.id), [id]);
  assert.throws(() => parseCastProposal(JSON.stringify({ assignments: [{ id, voice: "Samantha", evidence: [anchor], extra: true }] }), context), /fields/);
  assert.throws(() => parseCastProposal(JSON.stringify({ assignments: [{ id, voice: "Samantha", evidence: [], reason: "x".repeat(301) }] }), context));
  const locked = { ...context, cast: state.cast.map((c, index) => index === 0 ? { ...c, locked: true } : c) };
  assert.throws(() => parseCastProposal(JSON.stringify(valid), locked), /unknown or locked/);
});

test("one invalid response gets one repair attempt and the second result is validated", async () => {
  const { state, context } = proposalFixture();
  const id = state.cast[0]!.id, anchor = context.packets[0]!.anchors[0]!;
  let calls = 0;
  const answer = JSON.stringify({ assignments: [{ id, voice: "Daniel", gender: "unclear", reason: "Dry.", evidence: [anchor] }] });
  const result = await requestCastProposal(async () => (++calls === 1 ? "this is not json" : answer), context);
  assert.equal(calls, 2);
  assert.equal(result[0]!.voice, "Daniel");
});

test("the casting prompt stays bounded when many characters are unlocked", () => {
  const { context } = proposalFixture();
  const many = Array.from({ length: 40 }, (_, index) => ({
    ...context.packets[0]!, characterId: `c${index}`, name: `CHARACTER ${index}`,
    lines: Array.from({ length: 4 }, (_, line) => ({ paragraphId: `c${index}-${line}`, sceneId: "s1", text: "x".repeat(220) })),
    descriptions: Array.from({ length: 3 }, (_, row) => ({ paragraphId: `c${index}-d${row}`, text: "y".repeat(260) })),
    parentheticals: [{ paragraphId: `c${index}-p`, text: "z".repeat(80) }],
  }));
  const request = castingRequest({ ...context, packets: many });
  const content = request.messages[0]!.content;
  assert.equal(typeof content, "string");
  assert((content as string).length <= 30_000);
  assert((content as string).includes("\"characters\""));
});

test("a second invalid response fails clearly and changes no cast", async () => {
  const { context } = proposalFixture();
  const session = new DocumentSession(ScreenplayDoc.fromScript(SCRIPT));
  writeCast(session, { characters: [row("m1", "MAYA", "Samantha", true)] });
  const before = JSON.stringify(readStoredCast(session.doc));
  let calls = 0;
  await assert.rejects(requestCastProposal(async () => { calls++; return '{"assignments":[{"id":"nobody","voice":"x","evidence":["nope"]}]}'; }, context), CastingProposalError);
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(readStoredCast(session.doc)), before);
});

// ---------- ensemble ----------

const voices: VoiceInfo[] = [
  { id: "a", engine: "system", name: "Low British", tags: ["british", "male", "low", "gravelly"] },
  { id: "b", engine: "system", name: "Bright American", tags: ["american", "female", "bright"] },
  { id: "c", engine: "system", name: "Dry American", tags: ["american", "male", "dry"] },
];

test("characters who share a scene get different voices", () => {
  const { packets } = proposalFixture();
  const subjects = packets.map((packet) => subjectFromPacket(packet));
  const assigned = assignEnsemble({ subjects, voices, narratorVoice: "b" });
  const maya = packets.find((packet) => packet.name === "MAYA")!.characterId;
  const eli = packets.find((packet) => packet.name === "ELI")!.characterId;
  assert.notEqual(assigned[maya], assigned[eli]);
});

test("ensemble assignment is deterministic, including when input order changes", () => {
  const { packets } = proposalFixture();
  const subjects = packets.map((packet) => subjectFromPacket(packet));
  const first = assignEnsemble({ subjects, voices, narratorVoice: "b" });
  const second = assignEnsemble({ subjects: [...subjects].reverse(), voices: [...voices].reverse(), narratorVoice: "b" });
  assert.deepEqual(second, first);
  assert.deepEqual(assignEnsemble({ subjects, voices, narratorVoice: "b" }), first);
});

test("explicit vocal evidence in the script outranks an arbitrary voice", () => {
  const subjects = [{ id: "x", name: "X", lineCount: 5, sceneIds: ["s1"], evidence: "She speaks with a British accent." }];
  assert.equal(assignEnsemble({ subjects, voices }).x, "a");
});

test("the narrator's voice is kept away from a major character and locks are untouched", () => {
  const subjects = [
    { id: "lead", name: "MAYA", lineCount: 90, sceneIds: ["s1"], evidence: "" },
    { id: "small", name: "SAM", lineCount: 2, sceneIds: ["s2"], evidence: "" },
  ];
  const assigned = assignEnsemble({ subjects, voices, narratorVoice: "a", locked: { small: "c" } });
  assert.notEqual(assigned.lead, "a");
  assert.equal(assigned.small, "c");
});

test("recasting one character leaves every other assignment alone", () => {
  const subjects = [
    { id: "maya", name: "MAYA", lineCount: 20, sceneIds: ["s1"], evidence: "" },
    { id: "eli", name: "ELI", lineCount: 18, sceneIds: ["s1"], evidence: "" },
    { id: "sam", name: "SAM", lineCount: 2, sceneIds: ["s2"], evidence: "" },
  ];
  const current = { maya: "a", eli: "b", sam: "c" };
  const next = recastCharacter({ subjects, voices, current }, "eli");
  assert.equal(next.maya, "a");
  assert.equal(next.sam, "c");
  assert.notEqual(next.eli, "b");
  assert.notEqual(next.eli, next.maya);
});

test("three audition choices are distinct, deterministic and use the character's own line", () => {
  const { packets } = proposalFixture();
  const subjects = packets.map((packet) => subjectFromPacket(packet));
  const maya = subjects.find((subject) => subject.name === "MAYA")!;
  const packet = packets.find((row) => row.characterId === maya.id)!;
  assert(packet.lines.length > 0);
  const first = auditionChoices({ subjects, voices, narratorVoice: "c", current: { maya: "a" } }, maya.id);
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map((voice) => voice.id)).size, 3);
  assert.deepEqual(auditionChoices({ subjects, voices, narratorVoice: "c", current: { maya: "a" } }, maya.id), first);
  assert.equal(auditionChoices({ subjects, voices: voices.slice(0, 2), narratorVoice: "c" }, maya.id).length, 2);
});

test("voiceInfos turns the installed list into tag-bearing candidates", () => {
  assert.deepEqual(voiceInfos(inventory, "system")[0], { id: "Samantha", engine: "system", name: "Samantha", tags: ["en-us", "american"] });
  assert.deepEqual(voiceInfos(inventory, "system")[1]!.tags, ["en-gb", "british"]);
  assert.equal(parseCast({ characters: [{ id: "m1", name: "MAYA", aliases: ["MARIA"], voices: { system: "Samantha" } }] }).cast[0]!.aliases[0], "MARIA");
  const state = fillCast(castForScript(SCRIPT, {}).state, "system", inventory);
  assert.equal(voiceMap(state, "system")[NARRATOR], inventory[0]!.id);
  assert.equal(writeCastState(new DocumentSession(ScreenplayDoc.fromScript(SCRIPT)), state), true);
  assert.deepEqual(state.cast.map((c: CastBinding) => c.name), ["MAYA", "ELI"]);
});


test("disconnected legacy edits migrate only their characters and preserve both new voices", () => {
  const legacy = { version: 1, narrator: { system: "Narrator" }, cast: [
    { ...row("m1", "MAYA", "Old Maya"), cueIds: ["m1", "m2"] },
    { ...row("e1", "ELI", "Old Eli"), cueIds: ["e1"] },
  ] };
  const { a, b, deliver } = sessionPair(legacy);
  writeCast(a, { characters: [row("m1", "MAYA", "New Maya")] });
  writeCast(b, { characters: [row("e1", "ELI", "New Eli")] });
  deliver();
  for (const session of [a, b]) {
    const stored = readStoredCast(session.doc);
    assert.equal(stored.characters.find((c) => c.id === "m1")!.voices.system, "New Maya");
    assert.equal(stored.characters.find((c) => c.id === "e1")!.voices.system, "New Eli");
    assert.equal(stored.narrator.system, "Narrator");
  }
});

test("concurrent first edits of one legacy character merge engines without restoring defaults", () => {
  const legacy = { cast: [{ ...row("m1", "MAYA", "Old Maya"), cueIds: ["m1", "m2"] }] };
  const { a, b, deliver } = sessionPair(legacy);
  writeCast(a, { characters: [row("m1", "MAYA", "New Maya", true)] });
  writeCast(b, { characters: [{ ...row("m1", "MAYA", ""), voices: { phonon: "UK_George" } }] });
  deliver();
  for (const session of [a, b]) {
    assert.equal(readStoredCast(session.doc).characters[0]!.locked, true);
    assert.deepEqual(readStoredCast(session.doc).characters[0]!.voices,
      { phonon: "UK_George", system: "New Maya" });
  }
  writeCast(b, { characters: [{ ...row("m1", "MAYA", ""), voices: { ming: "another" } }] });
  deliver();
  assert.equal(readStoredCast(a.doc).characters[0]!.voices.system, "New Maya");
});

test("legacy cue identity survives migration, deletion of m1 and rename of m2", () => {
  const session = new DocumentSession(ScreenplayDoc.fromScript(SCRIPT));
  session.doc.meta.set(LEGACY_CAST_KEY, {
    cast: [{ ...row("m1", "MAYA", "Samantha", true, ["MAY"]), cueIds: ["m1", "m2"] }],
  });
  writeCast(session, { characters: [row("e1", "ELI", "Moira")] });
  const deleted = { ...SCRIPT, paragraphs: SCRIPT.paragraphs.filter((p) => !["m1", "md"].includes(p.id)) };
  const afterDelete = castForScript(deleted, readStoredCast(session.doc)).state;
  writeCastState(session, afterDelete);
  const renamed = { ...deleted, paragraphs: deleted.paragraphs.map((p) =>
    p.id === "m2" ? { ...p, runs: [{ text: "MARIA" }] } : p) };
  const binding = castForScript(renamed, readStoredCast(session.doc)).state.cast.find((c) => c.name === "MARIA")!;
  assert.equal(binding.id, "m1");
  assert.equal(binding.voices.system, "Samantha");
  assert.equal(binding.locked, true);
  assert(binding.aliases.includes("MAY"));
});

test("a later v2 write from an older peer still shows through fields the v3 writers never touched", () => {
  const v2Row = (doc: ScreenplayDoc, voice: string, locked: boolean, aliases: string[]) => {
    const map = new Y.Map<unknown>();
    map.set("name", "MAYA"); map.set("locked", locked);
    const list = new Y.Array<string>(); list.push(aliases); map.set("aliases", list);
    const voices = new Y.Map<string>(); voices.set("system", voice); map.set("voices", voices);
    doc.meta.set("tableRead.cast.v2.character.m1", map);
  };
  const { a, b, deliver } = sessionPair();
  a.edit(() => v2Row(a.doc, "Samantha", false, []));
  deliver();
  writeCast(a, { characters: [{ id: "m1", name: "MAYA", aliases: [], locked: false, voices: { system: "Samantha", phonon: "UK_George" } }] });
  b.edit(() => v2Row(b.doc, "Daniel", true, ["MAYA HALE"]));
  deliver();
  for (const session of [a, b]) {
    const maya = readStoredCast(session.doc).characters.find((c) => c.id === "m1")!;
    assert.deepEqual(maya.voices, { phonon: "UK_George", system: "Daniel" });
    assert.equal(maya.locked, true);
    assert.deepEqual(maya.aliases, ["MAYA HALE"]);
  }
});

test("v3 data survives when the legacy row is deleted or flattened by a history restore", () => {
  const doc = ScreenplayDoc.fromScript(SCRIPT);
  const map = new Y.Map<unknown>();
  map.set("name", "MAYA"); map.set("locked", false);
  const voices = new Y.Map<string>(); voices.set("system", "Samantha"); map.set("voices", voices);
  doc.meta.set("tableRead.cast.v2.character.m1", map);
  const session = new DocumentSession(doc);
  writeCast(session, { characters: [{ id: "m1", name: "MAYA", aliases: [], locked: true, voices: { system: "Samantha", phonon: "UK_George" } }] });
  // A restore writes the old row back as plain JSON, not nested maps.
  doc.meta.set("tableRead.cast.v2.character.m1", { name: "MAYA", aliases: ["M"], cueIds: [], locked: false, voices: { system: "Daniel" } });
  let maya = readStoredCast(doc).characters.find((c) => c.id === "m1")!;
  assert.deepEqual(maya.voices, { phonon: "UK_George", system: "Daniel" });
  assert.equal(maya.locked, true);
  doc.meta.delete("tableRead.cast.v2.character.m1");
  maya = readStoredCast(doc).characters.find((c) => c.id === "m1")!;
  assert.equal(maya.name, "MAYA");
  assert.equal(maya.voices.phonon, "UK_George");
  assert.equal(maya.locked, true);
});

test("a locked voice outside the pool stays on its role and is never handed to anyone else", () => {
  const { packets } = proposalFixture();
  const subjects = packets.map((packet) => subjectFromPacket(packet));
  const maya = packets.find((packet) => packet.name === "MAYA")!.characterId;
  const assigned = assignEnsemble({ subjects, voices, narratorVoice: "b", locked: { [maya]: "Bells" } });
  assert.equal(assigned[maya], "Bells");
  assert.deepEqual(Object.entries(assigned).filter(([id, voice]) => voice === "Bells" && id !== maya), []);
});
