import assert from "node:assert/strict";
import test from "node:test";
import { compileReadPlan, DEFAULT_READ_OPTIONS, type Script } from "@screenplay/engine";
import { captureRead, compareTake, estimatedDuration, modeOptions, readRevision, restrictPassages, resumeIndex } from "../src/renderer/features/table-read/workflow.ts";
import { ReadPlayer, type AudioHandle } from "../src/renderer/features/table-read/player.ts";
const script: Script = { titlePage: [], paragraphs: [
  { id: "s", type: "sceneHeading", runs: [{ text: "INT. ROOM" }] },
  { id: "a", type: "action", runs: [{ text: "The door opens." }] },
  { id: "c", type: "character", runs: [{ text: "MAYA" }] },
  { id: "d", type: "dialogue", runs: [{ text: "Stay here." }] },
  { id: "e", type: "dialogue", runs: [{ text: "Please." }] },
] };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
test("modes, partial joined selections, resume and alternate previews keep the script immutable", () => {
  const before = structuredClone(script);
  const options = modeOptions({ action: true, names: true, headings: true, parentheticals: true }, "dialogue");
  const cues = compileReadPlan(script, options);
  assert.deepEqual(cues.map((cue) => cue.text), ["Stay here. Please."]);
  const selected = restrictPassages(cues, new Set(["e"]), script);
  assert.deepEqual(selected.map((cue) => cue.text), ["Please."]);
  assert.equal(resumeIndex(cues, { paragraphId: "e", offset: 2 }), 0);
  assert.equal(resumeIndex(cues, { paragraphId: "deleted", offset: 0 }), -1);
  const takes = compareTake(script, "e", "Go now.", DEFAULT_READ_OPTIONS);
  assert.deepEqual(takes.map((cue) => cue.text), ["Go now."]);
  assert.equal(takes[0]!.speaker, "MAYA");
  assert.notEqual(readRevision(takes), readRevision(cues));
  assert(estimatedDuration(cues, 1, 180) > estimatedDuration(cues, 1.5, 180));
  assert.deepEqual(script, before);
});
function fixture() {
  const cues = Array.from({ length: 8 }, (_, i) => ({ ...compileReadPlan(script)[0]!, id: String(i), text: String(i) }));
  const requests: string[] = [], heard: string[][] = [], endings: (() => void)[] = [];
  const cache = new Map<string, Uint8Array>();
  let syntheses = 0;
  const handle = (): AudioHandle => {
    let end!: () => void;
    const done = new Promise<void>((resolve) => { end = resolve; });
    endings.push(end);
    return { done, stop: end, pause() {}, async resume() {}, rate() {} };
  };
  const player = new ReadPlayer({
    async synthesize(cue) {
      requests.push(cue.id);
      if (!cache.has(cue.text)) { syntheses++; cache.set(cue.text, new TextEncoder().encode(cue.text)); }
      return cache.get(cue.text)!;
    },
    async cancel() {}, highlight() {},
    audio(bytes) { heard.push([new TextDecoder().decode(bytes)]); return handle(); },
    audioGroup(items) { heard.push(items.map((item) => new TextDecoder().decode(item.bytes))); return handle(); },
  });
  player.setGap(0);
  return { player, cues, requests, heard, endings, count: () => syntheses };
}
test("bounded prefetch requests the current cue first and arbitrary seek cancels old playback", async () => {
  const f = fixture(); f.player.play(f.cues); await tick();
  assert.deepEqual(f.requests, ["0", "1", "2", "3", "4"]);
  assert.deepEqual(f.heard, [["0"]]);
  f.player.seek(6); await tick();
  assert.deepEqual(f.heard, [["0"], ["6"]]);
  f.player.close(); await tick(); assert.equal(f.player.state, "idle");
});
test("dual dialogue defaults to sequential and simultaneous lanes form one clock group", async () => {
  for (const simultaneous of [false, true]) {
    const f = fixture(); const cues = f.cues.slice(0, 2).map((cue, i) => ({ ...cue, dual: "pair", lane: (i + 1) as 1 | 2 }));
    f.player.setSimultaneous(simultaneous); f.player.play(cues); await tick();
    assert.deepEqual(f.heard, simultaneous ? [["0", "1"]] : [["0"]]);
    f.endings[0]!(); await tick();
    if (!simultaneous) { assert.deepEqual(f.heard, [["0"], ["1"]]); f.endings[1]!(); await tick(); }
    assert.equal(f.player.state, "finished"); f.player.close();
  }
});
test("editing one speech reuses every unchanged synthesis in a fake cache", async () => {
  const f = fixture(); const cues = f.cues.slice(0, 3);
  f.player.play(cues); await tick(); f.player.stop(); assert.equal(f.count(), 3);
  f.player.play(cues.map((cue, i) => i === 1 ? { ...cue, text: "Edited" } : cue)); await tick();
  assert.equal(f.count(), 4); f.player.stop();
});
test("close, output change and helper failure discard delayed jobs", async () => {
  for (const reason of ["close", "output", "helper"] as const) {
    const f = fixture(); let resolve!: (bytes: Uint8Array) => void; const heard: string[] = [];
    const p = new ReadPlayer({ synthesize: () => new Promise((done) => { resolve = done; }), async cancel() {}, highlight() {},
      audio() { heard.push("stale"); throw new Error("must not play"); } });
    p.play(f.cues.slice(0, 1)); await tick();
    if (reason === "close") p.close(); else if (reason === "output") p.outputChanged(); else p.helperFailed("Helper stopped");
    resolve(new Uint8Array()); await tick(); assert.deepEqual(heard, []);
    assert.equal(p.state, reason === "helper" ? "error" : "idle");
  }
});

test("a late result from a replaced document never reaches the new document's clock", async () => {
  const cues = fixture().cues;
  let late!: (bytes: Uint8Array) => void;
  const heard: string[] = [];
  const p = new ReadPlayer({
    synthesize: (cue) => cue.id === "0" ? new Promise((resolve) => { late = resolve; }) : Promise.resolve(new TextEncoder().encode("new document")),
    async cancel() {}, highlight() {},
    audio(bytes) { heard.push(new TextDecoder().decode(bytes)); return { done: Promise.resolve(), pause() {}, async resume() {}, stop() {}, rate() {} }; },
  });
  p.setGap(0); p.play([cues[0]!]); await tick();
  p.replaceDocument(); assert.equal(p.cues.length, 0);
  p.play([cues[1]!]); await tick(); late(new TextEncoder().encode("old document")); await tick();
  assert.deepEqual(heard, ["new document"]); assert.equal(p.state, "finished");
});

test("listening notes retain their captured revision and source anchor after a scene moves", async () => {
  const { ScreenplayDoc } = await import("@screenplay/engine");
  const { listeningNote } = await import("../src/renderer/features/table-read/notes.ts");
  const { putRecord, records, resolveAnchor } = await import("../src/renderer/features/rewrite/records.ts");
  const doc = ScreenplayDoc.fromScript(script);
  try {
    const cue = compileReadPlan(script)[1]!;
    const before = doc.meta.toJSON();
    assert.throws(() => listeningNote({ doc, readOnly: true }, cue, { id: "read", revision: "old" }), /read-only/);
    assert.deepEqual(doc.meta.toJSON(), before);
    const note = listeningNote({ doc, readOnly: false }, cue, { id: "read", revision: "old" });
    putRecord(doc, { ...note, text: "Try a pause." });
    const moved = doc.toScript();
    moved.paragraphs.unshift({ id: "new", type: "sceneHeading", runs: [{ text: "EXT. ROAD" }] });
    doc.load(moved);
    assert.deepEqual(resolveAnchor(doc, note.anchor), { paragraphId: "d", from: 0, to: 10 });
    const saved = records(doc, "note")[0] as typeof note & { readSession: { revision: string } };
    assert.equal(saved.readSession.revision, "old");
  } finally { doc.ydoc.destroy(); }
});


test("export capture pins source, voice map and revision before asynchronous dialogs or rendering", () => {
  const cues = compileReadPlan(script), voices = { MAYA: "voice-one" };
  const captured = captureRead(cues, voices);
  const revision = captured.sourceRevision;
  cues[1]!.text = "Changed after the save dialog opened.";
  voices.MAYA = "voice-two";
  assert.equal(captured.cues[1]!.text, "Stay here. Please.");
  assert.equal(captured.voices.MAYA, "voice-one");
  assert.equal(readRevision(captured.cues), revision);
  assert.notEqual(readRevision(cues), revision);
});
