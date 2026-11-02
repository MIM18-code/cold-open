// Table-read data beside an FDX or Fountain script, its matching rules and the portable bundle. The sidecar is
// never written silently, a mismatch never attaches, and a bundle import can only reach fields the format names.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseFdx, parseFountain, ScreenplayDoc, writeFdx, writeFountain,
  type Script,
} from "@screenplay/engine";
import { DocumentSession, type SourceFormat } from "../src/renderer/core/session.ts";
import { readStoredCast, writeCast } from "../src/renderer/features/table-read/cast-store.ts";
import { PRONUNCIATION_KEY } from "../src/renderer/features/table-read/pronunciation.ts";
import { anchorAt, createRecord, putRecord, records, resolveAnchor } from "../src/renderer/features/rewrite/records.ts";
import {
  applySidecar, buildSidecar, duplicateDestination, reviewedMatch, buildSourceManifest, hasTableReadData, matchSidecar, noteAnchorIn,
  parseSidecar, type TableReadSidecar,
} from "../src/renderer/features/table-read/sidecar.ts";
import {
  assertAssetBudget, BUNDLE_EXTENSION, BUNDLE_IMPORT_EXTENSIONS, createBundle, decodedBytes, LEGACY_BUNDLE_EXTENSION,
  parseBundle, MAX_REFERENCE_BYTES,
} from "../src/renderer/features/table-read/bundle.ts";
import {
  importReferences, isShareableProvenance, isScriptPath, LEGACY_SIDECAR_SUFFIX, readSidecar, shareableReferences, sidecarPathFor, writeSidecar, SIDECAR_SUFFIX,
} from "../src/main/table-read-sidecar.ts";
import { ReferenceBank } from "../src/main/tts/reference-bank.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";

const SCRIPT: Script = { titlePage: [], paragraphs: [
  { id: "s1", type: "sceneHeading", sceneId: "s1", runs: [{ text: "INT. DINER - NIGHT" }] },
  { id: "m1", type: "character", runs: [{ text: "MAYA" }] },
  { id: "md", type: "dialogue", runs: [{ text: "The door was open." }] },
  { id: "e1", type: "character", runs: [{ text: "ELI" }] },
  { id: "ed", type: "dialogue", runs: [{ text: "Then we close it." }] },
] };
const OTHER: Script = { titlePage: [], paragraphs: [
  { id: "x1", type: "sceneHeading", sceneId: "x1", runs: [{ text: "EXT. PIER - DAWN" }] },
  { id: "x2", type: "character", runs: [{ text: "VOSS" }] },
  { id: "x3", type: "dialogue", runs: [{ text: "Nothing came back." }] },
] };

function sessionWith(script: Script = SCRIPT, format: SourceFormat = "fdx", extra = true): DocumentSession {
  const session = new DocumentSession(ScreenplayDoc.fromScript(script), { path: "/tmp/Draft.fdx", format, name: "Draft" });
  session.undo.clear();
  if (!extra) return session;
  writeCast(session, { narrator: { system: "Daniel" }, characters: [
    { id: "m1", name: "MAYA", aliases: [], locked: true, voices: { system: "Samantha" } },
    { id: "e1", name: "ELI", aliases: ["ELEANOR"], locked: false, voices: { system: "Moira", qwen: "voice-eli" } },
  ] });
  session.edit(() => session.doc.meta.set(PRONUNCIATION_KEY, [{ from: "Maya", to: "May-ah" }]));
  session.edit(() => putRecord(session.doc, createRecord("note", "Listening note", "Try a beat.", {
    anchor: anchorAt(session.doc, { paragraphId: "md", offset: 0 }, { paragraphId: "md", offset: 8 }),
    ...({ readSession: { id: "read-1", revision: "rev-1", spokenText: "The door was open." } } as object),
  })));
  return session;
}

const sidecarOf = (session: DocumentSession, project = PROJECT): TableReadSidecar =>
  buildSidecar(session, { projectId: project, created: "2026-10-31T00:00:00.000Z" });

function wav(): Buffer {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF"); bytes.writeUInt32LE(40, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24); bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}

// ---------- sidecar round trip ----------

test("an FDX sidecar round-trips cast, pronunciations and listening notes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "table-read-sidecar-"));
  try {
    const scriptPath = join(dir, "Draft.fdx");
    const sidecar = sidecarOf(sessionWith());
    assert.equal(sidecar.source.format, "fdx");
    assert.deepEqual(sidecar.source.characters.map((row) => row.id).sort(), ["e1", "m1"]);
    assert(sidecar.source.characters.every((row) => row.cueIds.length > 0), "FDX keeps cue paragraph IDs");
    assert.equal(sidecar.cast.characters.find((row) => row.id === "m1")!.locked, true);
    assert.equal(sidecar.pronunciations[0]!.to, "May-ah");
    assert.equal(sidecar.notes.length, 1);

    await writeSidecar(scriptPath, JSON.stringify(sidecar));
    const text = await readSidecar(scriptPath);
    assert.equal(text === null, false);
    const parsed = parseSidecar(JSON.parse(text!));
    assert.deepEqual(parsed.cast, sidecar.cast);
    assert.deepEqual(parsed.pronunciations, sidecar.pronunciations);
    assert.deepEqual(parsed.notes, sidecar.notes);
    assert.equal(parsed.projectId, PROJECT);
    assert.deepEqual(await readdir(dir), ["Draft.fdx" + SIDECAR_SUFFIX]);

    // A second write replaces the file through a random temporary name, leaving nothing behind.
    await writeSidecar(scriptPath, JSON.stringify({ ...sidecar, updated: "2026-11-01T00:00:00.000Z" }));
    assert.deepEqual(await readdir(dir), ["Draft.fdx" + SIDECAR_SUFFIX]);
    assert.equal((await readSidecar(scriptPath))!.includes("2026-11-01"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a script with only an old-named sidecar still restores it, and the new name wins when both exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "table-read-legacy-"));
  try {
    const scriptPath = join(dir, "Draft.fdx");
    assert.equal(SIDECAR_SUFFIX, ".coldopen-read.json");
    assert.equal(LEGACY_SIDECAR_SUFFIX, ".inklot-read.json");
    assert.equal(await readSidecar(scriptPath), null);

    const sidecar = sidecarOf(sessionWith());
    await writeFile(scriptPath + LEGACY_SIDECAR_SUFFIX, JSON.stringify(sidecar));
    const old = parseSidecar(JSON.parse((await readSidecar(scriptPath))!));
    assert.deepEqual(old.cast, sidecar.cast);
    assert.equal(old.projectId, PROJECT);

    await writeFile(scriptPath + SIDECAR_SUFFIX, JSON.stringify({ ...sidecar, projectId: "22222222-2222-4222-8222-222222222222" }));
    assert.equal(parseSidecar(JSON.parse((await readSidecar(scriptPath))!)).projectId, "22222222-2222-4222-8222-222222222222");

    // New writes use the new name and retire the old file, so deleting the new one can't bring stale data back.
    await rm(scriptPath + SIDECAR_SUFFIX);
    await writeSidecar(scriptPath, JSON.stringify({ ...sidecar, projectId: "33333333-3333-4333-8333-333333333333" }));
    assert.deepEqual(await readdir(dir), ["Draft.fdx" + SIDECAR_SUFFIX]);
    await rm(scriptPath + SIDECAR_SUFFIX);
    assert.equal(await readSidecar(scriptPath), null);

    // Neither sidecar name is itself a script.
    assert.equal(isScriptPath(scriptPath + LEGACY_SIDECAR_SUFFIX), false);
    assert.equal(isScriptPath(scriptPath + SIDECAR_SUFFIX), false);
    assert.equal(sidecarPathFor(scriptPath), scriptPath + SIDECAR_SUFFIX);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bundle exports as .coldopenread and imports from that or the old .inklotread name", () => {
  assert.equal(BUNDLE_EXTENSION, "coldopenread");
  assert.deepEqual(BUNDLE_IMPORT_EXTENSIONS, ["coldopenread", LEGACY_BUNDLE_EXTENSION]);
  assert.equal(LEGACY_BUNDLE_EXTENSION, "inklotread");
  // The bytes of a bundle exported before the rename carry the old format string and no extension of their own.
  const sidecar = sidecarOf(sessionWith());
  const oldBytes = JSON.stringify({ format: "inklot.read-bundle", version: 1, project: sidecar, references: [], rendered: [] });
  assert.deepEqual(parseBundle(oldBytes).project.cast, sidecar.cast);
  assert.deepEqual(parseBundle(JSON.stringify(createBundle({ sidecar, references: [] }))).project.cast, sidecar.cast);
});

test("a Fountain sidecar carries names and fingerprints but no paragraph IDs", async () => {
  const session = sessionWith(SCRIPT, "fountain");
  const sidecar = sidecarOf(session);
  assert.equal(sidecar.source.format, "fountain");
  assert(sidecar.source.characters.every((row) => row.cueIds.length === 0));
  assert(sidecar.source.characters.every((row) => row.fingerprint.length > 0));
});

test("a sidecar read refuses a link and a write replaces it instead of writing through it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "table-read-link-"));
  try {
    const scriptPath = join(dir, "Draft.fdx");
    const outside = join(dir, "outside.json");
    await writeFile(outside, "{\"untouched\":true}");
    await symlink(outside, scriptPath + SIDECAR_SUFFIX);
    await assert.rejects(() => readSidecar(scriptPath), /link/i);
    await writeSidecar(scriptPath, "{\"fresh\":true}");
    assert.equal(await readFile(outside, "utf8"), "{\"untouched\":true}");
    assert.equal(await readFile(scriptPath + SIDECAR_SUFFIX, "utf8"), "{\"fresh\":true}");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- matching ----------

test("an unchanged FDX matches exactly, including after a Final Draft round trip", () => {
  const sidecar = sidecarOf(sessionWith());
  const reopened = new DocumentSession(ScreenplayDoc.fromScript(parseFdx(writeFdx(SCRIPT))), { format: "fdx" });
  const match = matchSidecar(sidecar, reopened.script(), "fdx");
  assert.equal(match.kind, "exact");
  assert.equal(match.pairs.length, 2);
  assert(match.pairs.every((pair) => pair.strength === "exact" && pair.strong));
});

test("a Fountain reimport gets fresh paragraph IDs and still matches by names and fingerprints", () => {
  const sidecar = sidecarOf(sessionWith(SCRIPT, "fountain"));
  const reparsed = parseFountain(writeFountain(SCRIPT));
  const reopened = new DocumentSession(ScreenplayDoc.fromScript(reparsed), { format: "fountain" });
  assert.notEqual(reparsed.paragraphs[1]!.id, "m1");
  const match = matchSidecar(sidecar, reopened.script(), "fountain");
  assert.equal(match.kind, "exact");
});

test("a changed line is partial, and an unresolved character is not attached", () => {
  const sidecar = sidecarOf(sessionWith());
  const changed: Script = { ...SCRIPT, paragraphs: SCRIPT.paragraphs.map((paragraph) =>
    paragraph.id === "ed" ? { ...paragraph, runs: [{ text: "We closed it already." }] } : paragraph) };
  const match = matchSidecar(sidecar, changed, "fdx");
  assert.equal(match.kind, "partial");
  assert.equal(match.pairs.find((pair) => pair.storedId === "m1")!.strength, "exact");
  const eli = match.pairs.find((pair) => pair.storedId === "e1")!;
  assert.equal(eli.currentId, "e1");
  assert.equal(eli.strength, "changed");
  assert.equal(eli.strong, true);
});

test("a rename keeps the character through its cue paragraph and offers a reviewed mapping", () => {
  const sidecar = sidecarOf(sessionWith());
  const renamed: Script = { ...SCRIPT, paragraphs: SCRIPT.paragraphs.map((paragraph) =>
    paragraph.id === "e1" ? { ...paragraph, runs: [{ text: "ELEANOR" }] } : paragraph) };
  const match = matchSidecar(sidecar, renamed, "fdx");
  assert.equal(match.kind, "partial");
  const pair = match.pairs.find((row) => row.storedId === "e1")!;
  assert.equal(pair.currentId, "e1");
  assert.equal(pair.currentName, "ELEANOR");

  const target = sessionWith(renamed, "fdx", false);
  applySidecar(target, sidecar, match, new Set(["e1"]));
  const stored = readStoredCast(target.doc);
  assert.deepEqual(stored.characters.map((row) => row.id), ["e1"]);
  assert.equal(stored.characters[0]!.name, "ELEANOR");
  assert(stored.characters[0]!.aliases.includes("ELI"));
  assert.equal(stored.narrator.system, "Daniel");
});

test("a Fountain rename with unchanged dialogue is inferred, not silently exact", () => {
  const sidecar = sidecarOf(sessionWith(SCRIPT, "fountain"));
  const renamed = parseFountain(writeFountain({ ...SCRIPT, paragraphs: SCRIPT.paragraphs.map((paragraph) =>
    paragraph.id === "m1" ? { ...paragraph, runs: [{ text: "MARA" }] } : paragraph) }));
  const match = matchSidecar(sidecar, ScreenplayDoc.fromScript(renamed).toScript(), "fountain");
  assert.equal(match.kind, "partial");
  const maya = match.pairs.find((pair) => pair.storedName === "MAYA")!;
  assert.equal(maya.strength, "inferred");
  assert.equal(maya.currentName, "MARA");
});

test("a different script never matches, even when the file name is the same", () => {
  const sidecar = sidecarOf(sessionWith());
  const match = matchSidecar(sidecar, OTHER, "fdx");
  assert.equal(match.kind, "mismatch");
  assert(match.pairs.every((pair) => pair.currentId === null));
});

// ---------- applying a reviewed mapping ----------

test("two stored characters mapped to one destination are rejected before anything is written", () => {
  const sidecar = sidecarOf(sessionWith());
  const match = matchSidecar(sidecar, SCRIPT, "fdx");
  const target = sessionWith(SCRIPT, "fdx", false);
  const doubled = reviewedMatch(match, { m1: "m1", e1: "m1" });
  assert(duplicateDestination(doubled), "the review reports the clash");
  const result = applySidecar(target, sidecar, doubled);
  assert.equal(result.applied, false);
  assert.match(result.reason ?? "", /MAYA|ELI/);
  assert.deepEqual(readStoredCast(target.doc).characters, []);
  assert.equal(target.doc.meta.get(PRONUNCIATION_KEY), undefined);
});

test("only confirmed mappings are written, while narrator, pronunciations and notes follow the project", () => {
  const sidecar = sidecarOf(sessionWith());
  const changed: Script = { ...SCRIPT, paragraphs: SCRIPT.paragraphs.map((paragraph) =>
    paragraph.id === "ed" ? { ...paragraph, runs: [{ text: "We closed it already." }] } : paragraph) };
  const match = matchSidecar(sidecar, changed, "fdx");
  const target = sessionWith(changed, "fdx", false);
  const result = applySidecar(target, sidecar, match, new Set(["m1"]));
  assert.equal(result.applied, true);
  assert.equal(result.characters, 1);
  assert.equal(result.pronunciations, 1);
  assert.equal(result.notes, 1);
  const stored = readStoredCast(target.doc);
  assert.deepEqual(stored.characters.map((row) => row.id), ["m1"]);
  assert.equal(stored.characters[0]!.voices.system, "Samantha");
  assert.equal(stored.narrator.system, "Daniel");
  assert.deepEqual(target.doc.meta.get(PRONUNCIATION_KEY), [{ from: "Maya", to: "May-ah" }]);
  assert.equal(records(target.doc, "note").length, 1);
});

test("imported reference voice IDs follow the cast, and a locked choice stays locked", () => {
  const sidecar = sidecarOf(sessionWith());
  const target = sessionWith(SCRIPT, "fdx", false);
  const match = matchSidecar(sidecar, SCRIPT, "fdx");
  applySidecar(target, sidecar, match, undefined, { "voice-eli": "local-voice-eli" });
  const eli = readStoredCast(target.doc).characters.find((row) => row.id === "e1")!;
  assert.equal(eli.voices.qwen, "local-voice-eli");
  assert.equal(eli.locked, false);
  assert.equal(readStoredCast(target.doc).characters.find((row) => row.id === "m1")!.locked, true);
});

test("a sidecar whose cast row IDs drifted from its source rows still attaches by name", () => {
  const sidecar = sidecarOf(sessionWith());
  const drifted: TableReadSidecar = {
    ...sidecar,
    cast: { ...sidecar.cast, characters: sidecar.cast.characters.map((row, index) => ({ ...row, id: `legacy-${index}` })) },
  };
  const target = sessionWith(SCRIPT, "fdx", false);
  const match = matchSidecar(drifted, SCRIPT, "fdx");
  const result = applySidecar(target, drifted, match);
  assert.equal(result.characters, 2);
  assert.deepEqual(readStoredCast(target.doc).characters.map((row) => row.id).sort(), ["e1", "m1"]);
});

test("an existing locked row keeps its voice and lock through an import", () => {
  const sidecar = sidecarOf(sessionWith());
  const target = sessionWith(SCRIPT, "fdx", false);
  writeCast(target, { characters: [{ id: "m1", name: "MAYA", aliases: [], locked: true, voices: { system: "Alex" } }] });
  const match = matchSidecar(sidecar, SCRIPT, "fdx");
  applySidecar(target, sidecar, match);
  const maya = readStoredCast(target.doc).characters.find((row) => row.id === "m1")!;
  assert.equal(maya.voices.system, "Alex");
  assert.equal(maya.locked, true);
});

test("a read-only session refuses every table-read write", () => {
  const sidecar = sidecarOf(sessionWith());
  const target = sessionWith(SCRIPT, "fdx", false);
  target.setReadOnly(true);
  const before = JSON.stringify(target.doc.meta.toJSON());
  const match = matchSidecar(sidecar, SCRIPT, "fdx");
  const result = applySidecar(target, sidecar, match);
  assert.equal(result.applied, false);
  assert.match(result.reason ?? "", /read-only/);
  assert.equal(JSON.stringify(target.doc.meta.toJSON()), before);
});

test("a listening note follows a surviving paragraph ID, and a Fountain note follows a unique quote", () => {
  const sidecar = sidecarOf(sessionWith());
  const note = sidecar.notes[0]!;
  const direct = sessionWith(SCRIPT, "fdx", false);
  assert.deepEqual(noteAnchorIn(direct.doc, note), { paragraphId: "md", from: 0, to: 8 });
  const reparsed = parseFountain(writeFountain(SCRIPT));
  const fountain = new DocumentSession(ScreenplayDoc.fromScript(reparsed), { format: "fountain" });
  const anchored = noteAnchorIn(fountain.doc, note);
  assert.equal(anchored?.paragraphId, reparsed.paragraphs[2]!.id);
  assert.equal(anchored?.from, 0);
});

test("sidecar parsing refuses unknown fields, invented pronunciations and oversized casts", () => {
  const sidecar = sidecarOf(sessionWith());
  assert.throws(() => parseSidecar({ ...sidecar, extra: true }), /Unknown field/);
  assert.throws(() => parseSidecar({ ...sidecar, pronunciations: [{ from: "Maya", to: "" }] }), /pronunciation/);
  assert.throws(() => parseSidecar({ ...sidecar, cast: { ...sidecar.cast, characters: [{ id: "x" }] } }), /Invalid/);
  assert.throws(() => parseSidecar({ ...sidecar, version: 2 }), /newer version/);
});

test("table-read data is detected from cast, pronunciations or listening notes", () => {
  assert.equal(hasTableReadData(sessionWith(SCRIPT, "fdx", false).doc), false);
  assert.equal(hasTableReadData(sessionWith().doc), true);
  const onlyRules = sessionWith(SCRIPT, "fdx", false);
  onlyRules.edit(() => onlyRules.doc.meta.set(PRONUNCIATION_KEY, [{ from: "Maya", to: "May-ah" }]));
  assert.equal(hasTableReadData(onlyRules.doc), true);
});

test("source manifests stay bounded and keep Fountain cue IDs empty", () => {
  const manifest = buildSourceManifest(SCRIPT, "fountain");
  assert.equal(manifest.characters.length, 2);
  assert(manifest.characters.every((row) => row.cueCount === 1 && row.lineCount === 1 && !row.cueIds.length));
  assert.notEqual(manifest.characters[0]!.fingerprint, manifest.characters[1]!.fingerprint);
});

// ---------- bundle ----------

const SHAREABLE = {
  id: "bank-mara", engine: "qwen" as const, label: "Mara",
  transcript: "A short line for the reference.", description: "Low, dry.",
  tags: ["starter", "adult"], provenance: "Inklot starter-bank recipe v1. Synthetic VoiceDesign reference.",
  generatorVersion: "helper-1", modelChecksum: "a".repeat(64),
  audioChecksum: "b".repeat(64), audio: wav().toString("base64"), shareable: true as const,
};

test("a bundle carries the project and shareable reference audio, and no paths or secrets", () => {
  const sidecar = sidecarOf(sessionWith());
  const local = { ...SHAREABLE, provenance: "Created from /Users/writer/voice.wav; starter-bank reference." };
  const bundle = createBundle({
    sidecar, references: [local],
    rendered: [{ name: "Draft table read.wav", mime: "audio/wav", audio: wav().toString("base64") }],
  });
  const json = JSON.stringify(bundle);
  assert.equal(json.includes("/Users/"), false);
  assert.equal(json.includes("voice-references"), false);
  assert.equal(json.includes("SAMPLE_KEY"), false);
  assert.equal(Object.keys(bundle).includes("path"), false);
  assert.equal(bundle.references[0]!.provenance.includes("[local path]"), true);
  const parsed = parseBundle(json);
  assert.deepEqual(parsed.project.cast, bundle.project.cast);
  assert.equal(parsed.references[0]!.id, "bank-mara");
  assert.equal(decodedBytes(parsed.rendered[0]!.audio), 48);
});

test("a non-shareable reference is refused by the builder and by an imported bundle", () => {
  const sidecar = sidecarOf(sessionWith());
  assert.throws(() => createBundle({ sidecar, references: [{ ...SHAREABLE, shareable: false } as never] }), /provenance/);
  const forged = { format: "inklot.read-bundle", version: 1, project: sidecar,
    references: [{ ...SHAREABLE, shareable: false }], rendered: [] };
  assert.throws(() => parseBundle(JSON.stringify(forged)), /may not be shared/);
});

test("a bundle refuses path traversal in audio names and zip or gzip pretending to be audio", () => {
  const sidecar = sidecarOf(sessionWith());
  const base = { format: "inklot.read-bundle", version: 1, project: sidecar, references: [], rendered: [] };
  for (const name of ["../../etc/passwd.wav", "/tmp/evil.wav", "..\\evil.wav", "C:\\evil.wav", ".hidden.wav"]) {
    assert.throws(() => parseBundle(JSON.stringify({ ...base,
      rendered: [{ name, mime: "audio/wav", audio: "UklGRg==" }] })), /audio name/);
  }
  for (const audio of ["UEsDBBQAAAA=", "H4sIAAAAAA==", "AAAA"]) {
    assert.throws(() => parseBundle(JSON.stringify({ ...base,
      rendered: [{ name: "read.wav", mime: "audio/wav", audio }] })), /WAV/);
  }
});

test("an entry larger than its cap and a total over the budget are refused before decoding", () => {
  const huge = "UklGR" + "A".repeat(22_369_619);
  const sidecar = sidecarOf(sessionWith());
  assert.throws(() => createBundle({ sidecar, references: [{ ...SHAREABLE, audio: huge }] }), /size limit/);
  assert.throws(() => assertAssetBudget([MAX_REFERENCE_BYTES, MAX_REFERENCE_BYTES, MAX_REFERENCE_BYTES + 1]), /exceeds the size limit/);
  assert.throws(() => assertAssetBudget(Array.from({ length: 33 }, () => 0)), /too many/);
  assert.equal(decodedBytes(huge) > MAX_REFERENCE_BYTES, true);
});

test("a bundle with an unknown field is refused rather than partially imported", () => {
  const bundle = createBundle({ sidecar: sidecarOf(sessionWith()) });
  assert.throws(() => parseBundle(JSON.stringify({ ...bundle, cast: {} })), /Unknown field/);
  assert.throws(() => parseBundle(JSON.stringify({ ...bundle, nested: { path: "/Users/someone/script" } })), /Unknown field/);
  assert.throws(() => parseBundle(new Uint8Array(70 * 1024 * 1024)), /too large/);
});

// ---------- reference voices ----------

test("provenance decides whether a reference voice may travel", () => {
  assert.equal(isShareableProvenance("Inklot starter-bank recipe v1. Synthetic VoiceDesign reference."), true);
  assert.equal(isShareableProvenance("Cold Open starter-bank recipe v1. Synthetic VoiceDesign reference."), true);
  assert.equal(isShareableProvenance("VoiceDesign reference created in Inklot from the starter bank."), true);
  assert.equal(isShareableProvenance("A private recording of a friend. Do not share."), false);
  assert.equal(isShareableProvenance("Inklot starter-bank reference, non-shareable."), false);
  assert.equal(isShareableProvenance("Local clone of an actor's film dialogue."), false);
});

test("only shareable references leave the bank, and importing one keeps its designed identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "table-read-bank-"));
  try {
    const bank = new ReferenceBank(root);
    const audio = wav();
    await bank.save({
      id: "bank-mara", label: "Mara", transcript: "A short line.", description: "Low, dry.",
      tags: ["starter"], provenance: "Inklot starter-bank recipe v1. Synthetic VoiceDesign reference.",
      generatorVersion: "helper-1", modelChecksum: "a".repeat(64),
    }, audio);
    await bank.save({
      id: "private-voice", label: "Private", transcript: "A short line.", description: "Private.",
      tags: [], provenance: "A private recording; do not share.", generatorVersion: "helper-1",
      modelChecksum: "c".repeat(64),
    }, audio);
    const shared = await shareableReferences(bank, ["bank-mara", "private-voice"]);
    assert.deepEqual(shared.map((row) => row.id), ["bank-mara"]);
    assert.equal(shared[0]!.audio.startsWith("UklGR"), true);
    assert.equal("audioPath" in shared[0]!, false);

    const saved = await importReferences(bank, [{ ...shared[0]!, audioBytes: audio }]);
    assert.deepEqual(saved, [{ oldId: "bank-mara", newId: "bank-mara" }]);
    const again = await importReferences(bank, [{ ...shared[0]!, audioBytes: audio }]);
    assert.deepEqual(again, [{ oldId: "bank-mara", newId: "bank-mara" }]);
    assert.equal((await bank.get("bank-mara")).reference.label, "Mara");
    await assert.rejects(() => importReferences(bank, [{
      ...shared[0]!, id: "other-voice", provenance: "Private recording; do not share.", audioBytes: audio,
    }]), /provenance/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("an externally changed action keeps its detached listening note through sidecar saves", async () => {
  const action = { id: "action", type: "action" as const, runs: [{ text: "The door opens." }] };
  const original = { ...SCRIPT, paragraphs: [action, ...SCRIPT.paragraphs] };
  const source = sessionWith(original, "fdx", false);
  source.edit(() => putRecord(source.doc, createRecord("note", "Try a beat", "Pause here.", {
    anchor: anchorAt(source.doc, { paragraphId: "action", offset: 0 }, { paragraphId: "action", offset: 15 }),
    ...({ readSession: { id: "read", revision: "revision" } } as object),
  })));
  const sidecar = sidecarOf(source);
  const changed = { ...original, paragraphs: original.paragraphs.map((p) =>
    p.id === "action" ? { ...p, runs: [{ text: "She leaves." }] } : p) };
  const target = sessionWith(changed, "fdx", false);
  const result = applySidecar(target, sidecar, matchSidecar(sidecar, changed, "fdx"));
  assert.equal(result.notes, 1);
  assert.equal(result.detachedNotes, 1);
  const note = records(target.doc, "note")[0]!;
  assert.equal(note.text, "Pause here.");
  assert.equal(resolveAnchor(target.doc, note.anchor), null);
  const root = await mkdtemp(join(tmpdir(), "detached-note-"));
  try {
    const path = join(root, "Draft.fdx");
    await writeSidecar(path, JSON.stringify(sidecarOf(target)));
    const saved = parseSidecar(JSON.parse((await readSidecar(path))!));
    assert.deepEqual(saved.notes[0]!.anchor, sidecar.notes[0]!.anchor);
    const reopened = sessionWith(changed, "fdx", false);
    applySidecar(reopened, saved, matchSidecar(saved, changed, "fdx"));
    assert.equal(records(reopened.doc, "note")[0]!.text, "Pause here.");
    target.edit(() => putRecord(target.doc, { ...note,
      anchor: anchorAt(target.doc, { paragraphId: "md", offset: 0 }) }));
    assert.equal(sidecarOf(target).notes.length, 1, "reattached notes, including empty quotes, still save");
    assert.equal(sidecarOf(target).notes[0]!.anchor.paragraphId, "md");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reference collision remapping follows both narrator and character voices", () => {
  const sidecar = sidecarOf(sessionWith());
  sidecar.cast.narrator.qwen = "voice-eli";
  const target = sessionWith(SCRIPT, "fdx", false);
  applySidecar(target, sidecar, matchSidecar(sidecar, SCRIPT, "fdx"), undefined,
    { "voice-eli": "imported-voice-eli" });
  const stored = readStoredCast(target.doc);
  assert.equal(stored.narrator.qwen, "imported-voice-eli");
  assert.equal(stored.characters.find((c) => c.id === "e1")!.voices.qwen, "imported-voice-eli");
});
