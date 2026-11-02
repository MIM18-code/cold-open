import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VOICE_PACKS, validateVoicePack } from "../src/main/models/voice-manifest.ts";

const root = new URL("../../../", import.meta.url);

test("native inference uses local loaders and unresolved Ming weights cannot be loaded", () => {
  const helper = readFileSync(new URL("native/voice-helper/Sources/VoiceHelper/VoiceHelper.swift", root), "utf8");
  assert.doesNotMatch(helper, /fromPretrained|\.initialize\(\)/);
  assert.match(helper, /MingDenseModel\.fromModelDirectory\(local\)/);
  assert.match(helper, /Qwen3TTSModel\.fromModelDirectory\(local\)/);
  assert.match(helper, /model\.load\(from: local\)/);
  const ming = VOICE_PACKS.find((pack) => pack.id === "ming")!;
  if (ming.unresolved) assert.throws(() => validateVoicePack(ming), /unresolved/);
  else validateVoicePack(ming);
  const notices = readFileSync(new URL("native/voice-helper/Sources/VoiceHelper/Notices/README.md", root), "utf8");
  assert.match(notices, /GPL/); assert.match(notices, /weight/); assert.match(notices, /voice/);
});
