// Apple's speech errors ("Failed to initialize recognizer", kAFAssistantErrorDomain 1101) don't say what to do.
// Lead with a next step and keep Apple's text as a detail.
const NO_SPEECH = /no speech detected|1110\b/i;
export function speechError(raw: string | undefined): string {
  const detail = (raw ?? "").trim();
  if (!detail || /cancel/i.test(detail) || NO_SPEECH.test(detail)) return "";
  const step = /allow microphone|not authorized|denied|permission/i.test(detail)
    ? "Dictation needs the microphone. Allow Microphone and Speech Recognition for Cold Open in Settings, then try again."
    : /unavailable for this iPhone|language|locale|not supported/i.test(detail)
      ? "On-device dictation isn’t available for this iPhone’s language. Type instead, or add a supported language in Settings → General → Keyboard."
      : /no microphone/i.test(detail)
        ? "No microphone is available. Disconnect other audio devices, then try again."
        : "Dictation stopped. Check that Dictation is on in Settings → General → Keyboard, then try again.";
  return step === detail ? step : `${step}\n(${detail})`;
}
