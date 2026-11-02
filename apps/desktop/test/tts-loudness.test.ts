import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeWave } from "../src/main/tts/loudness.ts";

function tone(seconds: number, amplitude: number, rate = 24000): Uint8Array {
  const frames = Math.floor(seconds * rate), b = Buffer.alloc(44 + frames * 2);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + frames * 2, 4); b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36, "ascii"); b.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) b.writeInt16LE(Math.round(amplitude * 32767 * Math.sin(2 * Math.PI * 1000 * i / rate)), 44 + i * 2);
  return new Uint8Array(b);
}

function measure(wav: Uint8Array): { integrated: number; peak: number } | null {
  const dir = mkdtempSync(join(tmpdir(), "loud-")), file = join(dir, "a.wav");
  try {
    writeFileSync(file, wav);
    const run = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
    return parse(run.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function parse(text: string) {
  const i = /I:\s+(-?[\d.]+) LUFS/.exec(text.slice(text.lastIndexOf("Summary"))), p = /Peak:\s+(-?[\d.]+) dBFS/.exec(text.slice(text.lastIndexOf("Summary")));
  return i && p ? { integrated: Number(i[1]), peak: Number(p[1]) } : null;
}
function hasFfmpeg() { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } }

test("quiet and loud 16-bit clips land at -20 LUFS under the true-peak ceiling", { skip: !hasFfmpeg() }, () => {
  for (const amplitude of [0.02, 0.9]) {
    const result = measure(normalizeWave(tone(3, amplitude)))!;
    assert.ok(Math.abs(result.integrated + 20) < 0.6, `integrated ${result.integrated}`);
    assert.ok(result.peak <= -1, `true peak ${result.peak}`);
  }
});

test("a real Mac voice line is normalized like the neural engines", { skip: process.platform !== "darwin" || !hasFfmpeg() }, () => {
  const dir = mkdtempSync(join(tmpdir(), "say-")), file = join(dir, "s.wav");
  try {
    execFileSync("/usr/bin/say", ["-o", file, "--file-format=WAVE", "--data-format=LEI16@24000", "The kitchen door was open when I got there, and nobody would tell me why."]);
    const result = measure(normalizeWave(new Uint8Array(readFileSync(file))))!;
    assert.ok(Math.abs(result.integrated + 20) < 1, `integrated ${result.integrated}`);
    assert.ok(result.peak <= -1, `true peak ${result.peak}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("silence and non-PCM16 audio pass through untouched", () => {
  const silent = tone(1, 0);
  assert.equal(normalizeWave(silent), silent);
  const float = Buffer.from(tone(1, 0.5)); float.writeUInt16LE(3, 20);
  const input = new Uint8Array(float);
  assert.equal(normalizeWave(input), input);
});

test("neural cache keys changed with the helper's level and validation pass", async () => {
  const { audioKey, ENGINE_VERSION } = await import("../src/main/tts/cache-key.ts");
  const request = { engine: "phonon", voice: "UK_George", text: "Hello." } as Parameters<typeof audioKey>[0];
  const identity = (engineVersion: string) => ({ engineVersion, modelChecksum: "m", quantization: "q", voiceChecksum: "v" });
  const v2 = "fluid-0.18.0-mlxAudio-87d0359538f8d7915ae77a41655dfcd891b6e614-mlx-0.33.0-helper-v2";
  assert.equal(typeof ENGINE_VERSION, "string");
  // helper-v3 builds could cache a cut-off take through the old overlong fallback.
  for (const old of [v2, v2.replace("helper-v2", "helper-v3")]) {
    assert.notEqual(ENGINE_VERSION, old);
    assert.notEqual(audioKey(request, identity(ENGINE_VERSION)), audioKey(request, identity(old)));
  }
});
