// The real thing: macOS `say` speaks a short scene, afconvert makes it 16 kHz WAV, and the real speech
// helper and a local Ollama model turn it into screenplay elements. Skipped, with the reason printed, when
// this Mac has no helper build, no Ollama or no model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DictationRuntime } from "../src/main/dictation/runtime.ts";
import { EMPTY_CONTEXT } from "../src/shared/channels/dictation.ts";

const SCENE = "Interior kitchen, night. Maya stands at the sink. Maya says, I can't do this anymore.";
const repoRoot = join(import.meta.dirname, "../../..");

function has(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("a spoken scene becomes a scene heading, action, a cue and dialogue", { timeout: 240_000 }, async (t) => {
  const skip = (reason: string) => {
    console.log(`dictation integration skipped: ${reason}`);
    t.skip(reason);
  };
  if (process.platform !== "darwin") return skip("needs macOS for say and afconvert");
  if (!has("say") || !has("afconvert")) return skip("say or afconvert is missing");
  const runtime = new DictationRuntime({ settings: () => ({}), lookup: { repoRoot, env: process.env } });
  try {
    const { helperPath, exists } = runtime.status();
    if (!exists) return skip(`no speech helper build at ${helperPath}`);
    const check = await runtime.check();
    if (!check.helper.ok) return skip(check.helper.message);
    if (!check.server.ok) return skip(check.server.message);

    const folder = mkdtempSync(join(tmpdir(), "dictation-integration-"));
    try {
      execFileSync("say", ["-o", join(folder, "scene.aiff"), SCENE]);
      execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", join(folder, "scene.aiff"), join(folder, "scene.wav")]);
      const audio = new Uint8Array(readFileSync(join(folder, "scene.wav")));

      const leftovers = readdirTemp();
      const prepared = await runtime.prepare();
      console.log(`speech engine ready in ${prepared.speechMs.toFixed(0)} ms${prepared.modelWarning ? `; model warning: ${prepared.modelWarning}` : ""}`);

      const stages: string[] = [];
      const take = await runtime.processAudio({ takeId: 1, audio, context: EMPTY_CONTEXT }, (stage) => stages.push(stage));
      console.log(`heard: ${take.transcript}`);
      console.log(take.elements.map((e) => `${e.type}: ${e.text}`).join("\n"));
      console.log(`timings ${JSON.stringify(take.timings)}; diagnostics ${take.diagnostics.map((d) => d.code).join(",") || "none"}`);

      assert.equal(take.error, undefined);
      assert.match(take.transcript, /kitchen/i);
      assert.match(take.transcript, /Maya/i);
      assert.deepEqual(stages, ["saved", "transcribing", "formatting", "done"]);
      const types = take.elements.map((e) => e.type);
      assert.equal(types[0], "sceneHeading");
      assert.ok(types.includes("action"));
      assert.ok(types.includes("character"));
      assert.ok(types.includes("dialogue"));
      assert.match(take.elements[0]!.text, /^INT\. .*KITCHEN.* - NIGHT$/);
      assert.equal(take.elements.find((e) => e.type === "character")?.text, "MAYA");
      assert.match(take.elements.find((e) => e.type === "dialogue")!.text, /anymore/i);
      assert.deepEqual(readdirTemp(), leftovers, "the temporary recording is gone");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  } finally {
    runtime.close();
  }
});

function readdirTemp(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("screenplay-dictation-"));
}
