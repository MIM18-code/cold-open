import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_OLLAMA_ENDPOINT, sameOllamaModel, type LocalAiSetup } from "../../shared/channels/ai.ts";
import { listModels, pickOllamaModel, type FetchLike } from "./providers.ts";

/** `selected` is the model chosen in Settings, if any: a deleted choice isn't ready even when another model is installed. */
export async function localAiSetup(endpoint = DEFAULT_OLLAMA_ENDPOINT, deps: {
  fetch: FetchLike; exists?: (path: string) => boolean; home?: string; selected?: string;
} = { fetch }): Promise<LocalAiSetup> {
  const exists = deps.exists ?? existsSync;
  const installed = exists("/Applications/Ollama.app") || exists(join(deps.home ?? homedir(), "Applications/Ollama.app"));
  try {
    const models = await listModels("ollama", { ollamaEndpoint: endpoint }, deps.fetch, AbortSignal.timeout(1500));
    const model = deps.selected ? models.some((m) => sameOllamaModel(m.id, deps.selected!)) : !!pickOllamaModel(models.map((m) => ({ name: m.id, size: m.size })));
    return { installed: true, running: true, model };
  } catch { return { installed, running: false, model: false }; }
}
