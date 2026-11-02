// Which provider a background AI feature (casting, sentence completion) uses: the one chosen in Settings.
// Choosing the local model keeps the script on this Mac even when ChatGPT is signed in or a key is saved.
import type { AiStatus, ProviderId } from "../../../shared/channels/ai.ts";

/** The provider chosen in Settings when it is ready; otherwise the local model. Never a cloud provider the writer didn't choose. */
export function preferredProvider(status: Pick<AiStatus, "providers" | "active">): ProviderId {
  const chosen = status.active.provider;
  return status.providers.some((p) => p.provider === chosen && p.ready) ? chosen : "ollama";
}

// Short names for sentences; the Settings labels describe the sign-in method.
const NAMES: Record<ProviderId, string> = { ollama: "the local model", chatgpt: "ChatGPT", anthropic: "Claude", google: "Gemini", openai: "OpenAI" };
export const providerName = (provider: ProviderId) => NAMES[provider];
