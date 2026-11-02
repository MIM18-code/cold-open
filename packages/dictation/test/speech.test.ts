// Exercises `speech-helper serve` through the TypeScript client. Needs the
// release build (swift build -c release in native/speech-helper), macOS `say`,
// and the engines' models already downloaded; skips otherwise.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SpeechHelper, type HelperEngine } from "../src/speech.ts";
import { words } from "../src/validation.ts";

const binary = fileURLToPath(new URL("../../../native/speech-helper/.build/release/speech-helper", import.meta.url));
const skip = !existsSync(binary) || process.platform !== "darwin" ? "speech-helper not built" : false;
const LINE = "Interior diner, night. Frank says, you left the lights on.";

for (const engine of ["parakeet", "apple"] as HelperEngine[]) {
  test(`${engine} transcribes a spoken line through serve`, { skip }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "speech-test-"));
    const helper = new SpeechHelper(binary);
    try {
      const wav = join(dir, "line.wav");
      execFileSync("say", ["-v", "Samantha", "-o", wav, "--data-format=LEI16@16000", LINE]);
      const speech = helper.engine(engine);
      await speech.prepare();
      const transcript = await speech.transcribe(wav);
      const expected = new Set(words(LINE));
      const heard = words(transcript.text).filter((w) => expected.has(w));
      assert.ok(heard.length >= expected.size - 2, `heard: ${transcript.text}`);
      assert.ok(transcript.audioSeconds > 1);
      await assert.rejects(helper.call("transcribe", engine, { path: join(dir, "missing.wav") }));
    } finally {
      helper.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
