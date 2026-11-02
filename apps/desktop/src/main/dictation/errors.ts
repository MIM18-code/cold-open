// Turns the helper's and the model server's failures into messages that say what to do.
import type { DictationConfig } from "./config.ts";

export function helperMissingMessage(path: string): string {
  return `The speech helper was not found at ${path}. Build it with "cd native/speech-helper && swift build -c release", `
    + `or choose its path in Settings > Dictation.`;
}

export function serverDownMessage(config: DictationConfig): string {
  return `Could not reach the model server at ${config.formatter.endpoint}. Start Ollama (open the Ollama app, or run "ollama serve" `
    + `in Terminal) and try again, or change the endpoint in Settings > Dictation.`;
}

export function modelMissingMessage(config: DictationConfig): string {
  return `The model server does not have ${config.formatter.model}. Run "ollama pull ${config.formatter.model}" in Terminal, `
    + `or choose another model in Settings > Dictation.`;
}

export function explainError(error: unknown, config: DictationConfig): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Speech helper could not start|ENOENT|EACCES/.test(message)) return helperMissingMessage(config.helperPath);
  if (/weights are not downloaded/i.test(message)) {
    return `The ${config.engine} speech model is not downloaded yet. Run "${config.helperPath} download --engine ${config.engine}" once, then try again.`;
  }
  if (/timeout|timed out|aborted/i.test(message) && /model server/i.test(message)) {
    return `The model server at ${config.formatter.endpoint} did not answer in time. The first take after starting Ollama can be slow; try again.`;
  }
  if (/HTTP 404/.test(message) || /model .*not found/i.test(message)) return modelMissingMessage(config);
  if (/Could not use the local model server|ECONNREFUSED|fetch failed/i.test(message)) return serverDownMessage(config);
  return message;
}
