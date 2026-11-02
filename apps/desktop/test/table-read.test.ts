import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NARRATOR, type ReadCue } from "@screenplay/engine";
import { ReaderRuntime, audioKey, parseSystemVoices, validWave } from "../src/main/tts/runtime.ts";
import { validateSynthesis } from "../src/shared/channels/table-read.ts";
import { ReadPlayer, type AudioHandle } from "../src/renderer/features/table-read/player.ts";
import { fillCast, parseCast, parseCastProposal, voiceMap } from "../src/renderer/features/table-read/casting.ts";
const tick = () => new Promise((r) => setTimeout(r, 5));
const cue = (id: string): ReadCue => ({ id, text: id, speaker: "MAYA", paragraphIds: [id], source: [{ paragraphId: id, from: 0, to: id.length }], sceneId: "s", sceneHeading: "INT. ROOM", kind: "dialogue" });
function fixture() {
  let pending: ((b: Uint8Array) => void) | null = null;
  const spoken: string[] = [], highlights: (string | undefined)[] = [], handles: { handle: AudioHandle; end(): void; paused: boolean }[] = [];
  let delayed = false, cancelled = 0;
  const p = new ReadPlayer({
    synthesize: async (c) => delayed ? new Promise<Uint8Array>((resolve) => { pending = resolve; }) : new TextEncoder().encode(c.text),
    cancel: async () => { cancelled++; }, highlight: (c) => highlights.push(c?.id),
    audio(bytes) {
      spoken.push(new TextDecoder().decode(bytes)); let end!: () => void; const done = new Promise<void>((r) => { end = r; });
      const entry = { handle: {} as AudioHandle, end, paused: false };
      entry.handle = { done, pause: () => { entry.paused = true; }, resume: async () => { entry.paused = false; }, stop: end, rate() {} }; handles.push(entry); return entry.handle;
    },
  }); p.setGap(0);
  return { p, spoken, handles, highlights, delay: () => { delayed = true; }, resolve: () => pending?.(new TextEncoder().encode("late")), cancellations: () => cancelled };
}
test("playback has one active voice, advances in order, and supports pause/resume", async () => {
  const f = fixture(); f.p.play([cue("one"), cue("two")]); await tick();
  assert.deepEqual(f.spoken, ["one"]); f.p.pause(); assert(f.handles[0]!.paused); f.p.resume(); assert(!f.handles[0]!.paused);
  f.handles[0]!.end(); await tick(); assert.deepEqual(f.spoken, ["one", "two"]);
  f.handles[1]!.end(); await tick(); assert.equal(f.p.state, "finished"); assert.equal(f.highlights.at(-1), undefined);
});
test("Stop while loading discards late audio and clears the editor highlight", async () => {
  const f = fixture(); f.delay(); f.p.play([cue("one")]); await tick(); f.p.stop(); f.resolve(); await tick();
  assert.deepEqual(f.spoken, []); assert.equal(f.p.state, "idle"); assert(f.cancellations() >= 2);
});
test("pausing before synthesis finishes cannot start sound behind the paused button", async () => {
  const f = fixture(); f.delay(); f.p.play([cue("one")]); await tick(); f.p.pause(); f.resolve(); await tick();
  assert.deepEqual(f.spoken, []); f.p.resume(); await tick(); assert.deepEqual(f.spoken, ["late"]); f.p.stop();
});
test("changing passages invalidates prefetched results from the old run", async () => {
  const f = fixture(); f.p.play([cue("old"), cue("old-next")]); await tick(); f.p.play([cue("new")]); await tick();
  assert.deepEqual(f.spoken, ["old", "new"]); f.p.stop();
});
test("voice assignment preserves locks and rejects invented AI characters or voices", () => {
  const inventory = [{ id: "a", label: "A", language: "en-US" }, { id: "b", label: "B", language: "en-GB" }, { id: "c", label: "C", language: "en-US" }];
  const state = parseCast({ cast: [{ id: "one", name: "MAYA", cueIds: ["one"], voices: { ming: "b" }, locked: true }, { id: "two", name: "ELI", cueIds: ["two"], voices: {} }], narrator: { ming: "a" } });
  const filled = fillCast(state, "ming", inventory, true); assert.equal(filled.cast[0]!.voices.ming, "b"); assert.equal(filled.cast[1]!.voices.ming, "c"); assert.equal(voiceMap(filled, "ming")[NARRATOR], "a");
  const context = { cast: state.cast, inventory, packets: [{ characterId: "two", anchors: ["two"] }] as never };
  assert.throws(() => parseCastProposal('{"assignments":[{"id":"one","voice":"a","evidence":["two"]}]}', context));
  assert.throws(() => parseCastProposal('{"assignments":[{"id":"two","voice":"invented","evidence":["two"]}]}', context));
  assert.equal(parseCastProposal('{"assignments":[{"id":"two","voice":"c","gender":"unclear","reason":"Contrast","evidence":["two"]}]}', context)[0]!.voice, "c");
  const italian = parseCast({ cast: [{ id: "one", name: "MAYA", cueIds: ["one"], voices: { system: "it" } }] });
  assert.equal(fillCast(italian, "system", [{ id: "en", label: "English", language: "en-US" }, { id: "it", label: "Italian", language: "it-IT" }]).cast[0]!.voices.system, "it");
});
test("IPC accepts speech data, not paths, shell commands or unlimited strings", () => {
  const valid = { id: "read-1", engine: "system" as const, voice: "Samantha", text: 'Quotes; $(commands) remain spoken text.' };
  assert.deepEqual(validateSynthesis(valid), valid);
  for (const bad of [{ ...valid, engine: "../../program" }, { ...valid, voice: "\0" }, { ...valid, text: "x".repeat(1201) }, { ...valid, id: "../x" }]) assert.throws(() => validateSynthesis(bad));
  assert.notEqual(audioKey(valid), audioKey({ ...valid, voice: "Daniel" }));
  assert.deepEqual(parseSystemVoices("Samantha en_US # Hello\nFred en_US # Hello\nAva (Premium) en_US # Hello\nDaniel (Enhanced) en_GB # Hello").map((v) => v.id), ["Ava (Premium)", "Daniel (Enhanced)"]);
});
function wav() { const b = Buffer.alloc(48); b.write("RIFF"); b.writeUInt32LE(40, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(4, 40); return b; }
test("runtime reuses audio only for exact engine/voice/text and can clear the bounded cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-test-")); let calls = 0;
  const runtime = new ReaderRuntime({ root, platform: "darwin", systemRun: async (args, input, signal) => {
    signal.throwIfAborted(); if (args[1] === "?") return "Samantha (Enhanced) en_US # Hello\nDaniel (Enhanced) en_GB # Hello";
    calls++; assert.equal(input, "Hello."); await writeFile(args[args.indexOf("-o") + 1]!, wav()); return "";
  } });
  try {
    await runtime.status(); const req = { id: "one", engine: "system" as const, voice: "Samantha (Enhanced)", text: "Hello." };
    const a = await runtime.synthesize(req); assert(!a.cached); assert(validWave(a.audio));
    const b = await runtime.synthesize({ ...req, id: "two" }); assert(b.cached); assert.equal(calls, 1);
    await runtime.synthesize({ ...req, id: "three", voice: "Daniel (Enhanced)" }); assert.equal(calls, 2);
    assert.equal((await readdir(root)).filter((f) => f.endsWith(".wav")).length, 2);
    await runtime.clearCache(); assert.equal(await runtime.cacheInfo(), 0);
    await assert.rejects(runtime.prepare("ming", false), /Confirm/);
  } finally { runtime.cancel(); await rm(root, { recursive: true, force: true }); }
});

// Phonon's fantasy character presets are the novelty voices now that Apple's sound-effect voices are not listed.
const novelty = (id: string) => ({ id, label: id, language: "en-US", tags: ["novelty"] });
const plain = (id: string) => ({ id, label: id, language: "en-US", tags: ["female"] });

test("automatic casting skips novelty voices but keeps them selectable", async () => {
  const { fillCast } = await import("../src/renderer/features/table-read/casting.ts");
  const voices = [novelty("characters_Azgorath"), novelty("characters_Bubbles"), plain("en_us_Delia"), plain("en_us_Harper"), plain("en_gb_Imogen")];
  const state = { narrator: {}, cast: ["A", "B", "C", "D"].map((name) => ({ id: name, name, aliases: [], voices: {}, locked: false })) } as never;
  const filled = fillCast(state, "phonon", voices) as unknown as { narrator: Record<string, string>; cast: { voices: Record<string, string> }[] };
  const picked = [filled.narrator.phonon, ...filled.cast.map((c) => c.voices.phonon)];
  assert.ok(picked.every((id) => !id!.startsWith("characters_")), picked.join(", "));
});

test("AI casting is offered real voices, and novelty voices only when nothing else is installed", async () => {
  const { castingRequest } = await import("../src/renderer/features/table-read/casting.ts");
  const cast = [{ id: "a", name: "A", aliases: [], voices: {}, locked: false }] as never;
  const voicesSent = (inventory: ReturnType<typeof plain>[]) => JSON.parse(castingRequest({ cast, inventory, packets: [] }).messages[0]!.content as string)
    .voices.map((v: { id: string }) => v.id);
  assert.deepEqual(voicesSent([novelty("characters_Azgorath"), plain("en_us_Delia")]), ["en_us_Delia"]);
  assert.deepEqual(voicesSent([novelty("characters_Azgorath"), novelty("characters_Bubbles")]), ["characters_Azgorath", "characters_Bubbles"]);
});

test("the ensemble and recast paths share the novelty filter", async () => {
  const { castable } = await import("../src/renderer/features/table-read/casting.ts");
  const voices = [novelty("characters_Azgorath"), novelty("characters_Bubbles"), plain("en_us_Delia"), plain("en_gb_Imogen")];
  assert.deepEqual(castable(voices).map((v) => v.id), ["en_us_Delia", "en_gb_Imogen"]);
  assert.deepEqual(castable(voices.slice(0, 2)).map((v) => v.id), ["characters_Azgorath", "characters_Bubbles"]);
});

test("a Premium voice added after the first scan appears without a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-rescan-")); let list = "Fred en_US # Hello";
  const runtime = new ReaderRuntime({ root, platform: "darwin", systemRun: async (args) => args[1] === "?" ? list : "" });
  try {
    const system = async () => (await runtime.status()).engines.find((e) => e.id === "system")!;
    assert.equal((await system()).voices.length, 0);
    assert.equal((await system()).ready, false);
    list += "\nAva (Premium) en_US # Hello";
    (runtime as any).systemScannedAt = 0;
    const after = await system();
    assert.deepEqual(after.voices.map((v) => v.id), ["Ava (Premium)"]);
    assert.equal(after.ready, true);
  } finally { runtime.cancel(); await rm(root, { recursive: true, force: true }); }
});
