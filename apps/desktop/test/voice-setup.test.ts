import assert from "node:assert/strict";
import test from "node:test";
import { downloadSize, memoryWarning, playbackPack } from "../src/renderer/features/table-read/voice-setup.ts";
import type { VoicePackState } from "../src/shared/channels/table-read.ts";
const pack = (id: string, installed: boolean): VoicePackState => ({ id, installed, engine: "qwen", label: id, memoryGB: 24,
  sizeBytes: 1024, diskBytes: 0, minimumMacOS: 15, license: "test", provenance: "fixture", revision: [] });

test("Qwen selection uses the installed Base variant even when the preferred variant is absent", () => {
  const small = pack("qwen-base-06b", true), large = pack("qwen-base-17b", false);
  assert.equal(playbackPack([small, large], "qwen", 64), small);
  large.installed = true;
  assert.equal(playbackPack([small, large], "qwen", 64), large);
  assert.equal(playbackPack([small, large], "qwen", 16), small);
  assert.equal(playbackPack([], "qwen", 16), undefined);
});

test("requirements warn only below the minimum and sizes remain readable", () => {
  const p = pack("qwen-base-17b", false);
  assert.match(memoryWarning(p, 16), /16 GB.*24 GB/);
  assert.equal(memoryWarning(p, 24), "");
  assert.equal(memoryWarning(p), "");
  assert.equal(downloadSize(2 * 1024 ** 3), "2.00 GB");
  assert.equal(downloadSize(1024 ** 2), "1.0 MB");
});
