import assert from "node:assert/strict";
import { test } from "node:test";

import { SpeechHelper } from "../src/speech.ts";

test("a missing helper binary rejects the call instead of crashing", async () => {
  const helper = new SpeechHelper("/nonexistent/speech-helper");
  await assert.rejects(helper.engine("parakeet").prepare(), /could not start/);
});
