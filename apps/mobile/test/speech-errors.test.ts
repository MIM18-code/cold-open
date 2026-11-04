import assert from "node:assert/strict";
import test from "node:test";
import { speechError } from "../src/speech-errors.ts";

test("speech failures lead with what to do and keep Apple's text as a detail", () => {
  const message = speechError("Failed to initialize recognizer");
  assert.match(message, /^Dictation stopped\. Check that Dictation is on in Settings → General → Keyboard, then try again\./);
  assert.match(message, /\(Failed to initialize recognizer\)$/);
  assert.match(speechError("Allow microphone and speech access in Settings."), /^Dictation needs the microphone/);
  assert.match(speechError("On-device speech is unavailable for this iPhone’s language."), /^On-device dictation isn’t available/);
  assert.match(speechError("No microphone available."), /^No microphone is available/);
  for (const quiet of ["", undefined, "Recognition request was canceled", "No speech detected"])
    assert.equal(speechError(quiet), "", `${quiet} is not an error the writer has to act on`);
});
