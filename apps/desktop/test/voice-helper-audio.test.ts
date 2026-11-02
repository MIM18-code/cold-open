import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../../../native/voice-helper/", import.meta.url));

test("the helper's output check accepts long spoken digits and keeps catching broken audio", { skip: process.platform !== "darwin" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "speech-audio-"));
  try {
    const binary = join(dir, "check");
    const build = spawnSync("swiftc", ["-O", "-o", binary, join(helper, "Sources/VoiceHelper/SpeechAudio.swift"),
      join(helper, "Tests/SpeechAudioCheck/main.swift")], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
