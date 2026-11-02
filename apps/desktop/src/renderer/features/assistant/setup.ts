import { app } from "../../core/app.ts";
import { desktop } from "../../core/platform.ts";
import { AI_CHANNELS } from "../../../shared/channels/ai.ts";

let shown = false;
const retries = new Map<object, () => void>();

export function openAiSetup(): void {
  shown = true;
  void desktop.invoke(AI_CHANNELS.offerSetup).catch(() => undefined);
  app.openModal("ai.setup");
}
export function offerAiSetup(): void {
  if (shown) return;
  shown = true;
  // Main owns the session gate because each document has its own renderer.
  void desktop.invoke<boolean>(AI_CHANNELS.offerSetup).then((offer) => { if (offer && app.ui.modal?.id !== "ai.setup") app.openModal("ai.setup"); }, () => undefined);
}
export function retryWhenAiReady(owner: object, retry: () => void): void { retries.set(owner, retry); }
export function cancelAiRetry(owner: object): void { retries.delete(owner); }
export function aiSetupReady(): void {
  const waiting = [...retries.values()];
  retries.clear();
  for (const retry of waiting) retry();
  if (!waiting.length) app.toast("AI is ready. Try again.", "success");
}
