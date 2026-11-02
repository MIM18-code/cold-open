import assert from "node:assert/strict";
import { test } from "node:test";

import { wavInfo } from "../src/main/dictation/wav-info.ts";
import { Resampler, downmix, encodeWav, meterPosition, peak, rms } from "../src/renderer/features/dictation/wav.ts";

test("the WAV encoder writes a 16 kHz mono 16-bit PCM header", () => {
  const wav = encodeWav([new Float32Array([0, 0.5, -0.5, 1, -1])]);
  const view = new DataView(wav.buffer);
  const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
  assert.equal(tag(0), "RIFF");
  assert.equal(tag(8), "WAVE");
  assert.equal(tag(12), "fmt ");
  assert.equal(view.getUint16(20, true), 1, "PCM");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000, "byte rate");
  assert.equal(view.getUint16(34, true), 16, "bits");
  assert.equal(tag(36), "data");
  assert.equal(view.getUint32(40, true), 10);
  assert.equal(view.getUint32(4, true), wav.length - 8);
  assert.equal(wav.length, 44 + 10);
});

test("samples are scaled to 16 bits and clipped", () => {
  const wav = encodeWav([new Float32Array([0, 0.5]), new Float32Array([-0.5, 1, -1, 2, -3])]);
  const view = new DataView(wav.buffer);
  const samples = Array.from({ length: 7 }, (_, i) => view.getInt16(44 + i * 2, true));
  assert.deepEqual(samples, [0, 16384, -16384, 32767, -32768, 32767, -32768]);
});

test("the main process reads back what the renderer wrote", () => {
  const info = wavInfo(encodeWav([new Float32Array(8000)]));
  assert.deepEqual(info, { sampleRate: 16000, channels: 1, bits: 16, seconds: 0.5 });
});

test("the main process refuses anything that is not a WAV file", () => {
  assert.throws(() => wavInfo(new Uint8Array(100)), /not a WAV/);
  assert.throws(() => wavInfo(new TextEncoder().encode("RIFF....WAVEfmt junk junk junk junk junk junk")), /valid WAV/);
});

test("48 kHz audio becomes 16 kHz, a third as many samples", () => {
  const out = new Resampler(48000).push(new Float32Array(48000).fill(0.25));
  assert.equal(out.length, 16000);
  assert.ok(out.every((value) => Math.abs(value - 0.25) < 1e-6));
});

test("resampling in small pieces gives the same samples as in one piece", () => {
  const input = Float32Array.from({ length: 4410 }, (_, i) => Math.sin(i / 20));
  const whole = new Resampler(44100).push(input);
  const piecewise = new Resampler(44100);
  const parts: number[] = [];
  for (let at = 0; at < input.length; at += 128) parts.push(...piecewise.push(input.subarray(at, at + 128)));
  assert.equal(parts.length, whole.length);
  parts.forEach((value, i) => assert.ok(Math.abs(value - whole[i]!) < 1e-5));
});

test("a 440 Hz tone keeps its frequency and most of its level through the resampler", () => {
  const rate = 48000;
  const tone = Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate));
  const out = new Resampler(rate).push(tone);
  let crossings = 0;
  for (let i = 1; i < out.length; i++) if (out[i - 1]! < 0 && out[i]! >= 0) crossings++;
  assert.ok(Math.abs(crossings - 440) <= 2, `crossings ${crossings}`);
  assert.ok(rms(out) > 0.33 && rms(out) < 0.36, `rms ${rms(out)}`);
});

test("channels are averaged to mono", () => {
  const mono = downmix([new Float32Array([1, 0, 0.5]), new Float32Array([0, 1, 0.5])]);
  assert.deepEqual(Array.from(mono), [0.5, 0.5, 0.5]);
});

test("peak and the meter tell silence from speech", () => {
  assert.ok(Math.abs(peak(new Float32Array([0, -0.8, 0.3])) - 0.8) < 1e-6);
  assert.equal(meterPosition(0), 0);
  assert.ok(meterPosition(0.0005) < 0.05);
  assert.ok(meterPosition(0.1) > 0.6 && meterPosition(0.1) < 0.8);
  assert.equal(meterPosition(1), 1);
});
