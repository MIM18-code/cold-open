// Plain one-line wording for dictation failures shown outside the Dictate panel (the quick note box).

/** Say what to do, in one sentence, for a failure of the microphone, the speech helper or the engine. */
export function plainSpeechError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (name === "NotAllowedError" || name === "SecurityError" || /microphone access/i.test(message)) {
    return "Cold Open can't use the microphone. Allow it in System Settings > Privacy & Security > Microphone.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found. Connect one and try again.";
  if (/speech helper|ENOENT|EACCES|not downloaded|Prepare .* first/i.test(message)) {
    return "Dictation isn't set up. Choose the speech helper in Settings > Dictation, or just type.";
  }
  if (/No speech/i.test(message)) return "No speech heard. Try again closer to the microphone.";
  if (/too short/i.test(message)) return "That was too short to transcribe.";
  const first = message.split(/\n/)[0]!.trim();
  return first.length > 140 ? `${first.slice(0, 137)}…` : first || "Dictation failed. Try again, or just type.";
}
