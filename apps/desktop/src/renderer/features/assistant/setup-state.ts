import type { AiStatus, LocalAiSetup } from "../../../shared/channels/ai.ts";
import type { ModelProgress } from "../../../main/models/ollama.ts";

export const AI_SETUP_MESSAGE = "Set up AI to use this feature.";
export type SetupStep = "checking" | "not-installed" | "not-running" | "no-model" | "downloading" | "paused" | "ready" | "chatgpt-ready";

/** `chatgptChosen` means the writer picked ChatGPT in the sheet, not merely that it's signed in: a signed-in ChatGPT
 * never replaces the local model the writer chose without a click. */
export function setupStep(local: LocalAiSetup | null, chatgptChosen: boolean, progress?: ModelProgress | null): SetupStep {
  if (chatgptChosen) return "chatgpt-ready";
  if (!local) return "checking";
  if (local.running && local.model) return "ready";
  if (!local.installed) return "not-installed";
  if (!local.running) return "not-running";
  if (progress?.state === "downloading" || progress?.state === "verifying") return "downloading";
  if (progress?.state === "paused") return "paused";
  return "no-model";
}

export const chatgptReady = (status: AiStatus) => status.providers.some((p) => p.provider === "chatgpt" && p.ready);
export const activeReady = (status: AiStatus) => status.providers.some((p) => p.provider === status.active.provider && p.ready);
export const needsAiSetup = (error: unknown): boolean => !!error && typeof error === "object" && "setupRequired" in error && error.setupRequired === true;
