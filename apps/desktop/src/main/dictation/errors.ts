// Turns the helper's and the model server's failures into messages that say what to do.
import { SETTING_DEFAULTS } from "../../shared/channels/dictation.ts";
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

export function diagnoseTake(error: unknown, config: DictationConfig): { error: string; needsFormatterSetup?: true } {
  const message = error instanceof Error ? error.message : String(error);
  if (/Speech helper could not start|ENOENT|EACCES/.test(message)) return { error: helperMissingMessage(config.helperPath) };
  if (/weights are not downloaded/i.test(message)) {
    return { error: `The ${config.engine} speech model is not downloaded yet. Run "${config.helperPath} download --engine ${config.engine}" once, then try again.` };
  }
  if (/timeout|timed out|aborted/i.test(message) && /model server/i.test(message)) {
    return { error: `The model server at ${config.formatter.endpoint} did not answer in time. The first take after starting Ollama can be slow; try again.` };
  }
  const missingModel = /HTTP 404|model .*not found/i.test(message);
  const unreachable = /ECONNREFUSED|fetch failed/i.test(message);
  const { formatter } = config;
  if ((missingModel || unreachable) && formatter.provider === SETTING_DEFAULTS.provider &&
      formatter.endpoint.replace(/\/+$/, "") === SETTING_DEFAULTS.endpoint && formatter.model === SETTING_DEFAULTS.model) {
    return { error: "Set up the local formatting model, then try again.", needsFormatterSetup: true };
  }
  if (missingModel) return { error: modelMissingMessage(config) };
  if (unreachable || /Could not use the local model server/i.test(message)) return { error: serverDownMessage(config) };
  return { error: message };
}

export function explainError(error: unknown, config: DictationConfig): string {
  return diagnoseTake(error, config).error;
}
