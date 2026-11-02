// Which provider a background AI feature (casting, sentence completion) uses, without asking the writer to choose:
// the local model, unless ChatGPT is signed in or an API key is set.
import type { AiStatus, ProviderId } from "../../../shared/channels/ai.ts";

const CLOUD_ORDER: readonly ProviderId[] = ["chatgpt", "anthropic", "openai", "google"];

/** A cloud provider chosen in Settings wins when it is ready; otherwise the first ready cloud provider; else Ollama. */
export function preferredProvider(status: Pick<AiStatus, "providers" | "active">): ProviderId {
  const ready = (provider: ProviderId) => status.providers.some((p) => p.provider === provider && p.ready);
  if (status.active.provider !== "ollama" && ready(status.active.provider)) return status.active.provider;
  return CLOUD_ORDER.find(ready) ?? "ollama";
}

// Short names for sentences; the Settings labels describe the sign-in method.
const NAMES: Record<ProviderId, string> = { ollama: "the local model", chatgpt: "ChatGPT", anthropic: "Claude", google: "Gemini", openai: "OpenAI" };
export const providerName = (provider: ProviderId) => NAMES[provider];
