// Runs AI requests: picks the provider and model from settings, adds the API key and the Backlot summary,
// streams the answer back as events and supports cancelling. Everything it needs comes in through RunnerDeps,
// so tests can supply fake transports and account state.
import {
  AI_SETTINGS, type ChatgptStatus, DEFAULT_OLLAMA_ENDPOINT, PROVIDERS, type AiEvent, type AiRequest, type AiStarted, type AiStatus, type AiTestResult,
  type AiTier, type ProviderId,
} from "../../shared/channels/ai.ts";
import { readBacklot } from "./backlot.ts";
import type { DirectProvider } from "./chatgpt-direct.ts";
import { isKeyedProvider, type KeyStore } from "./keys.ts";
import {
  AiError, DEFAULT_MODELS, type FetchLike, listModels, pickOllamaModel, streamChat,
} from "./providers.ts";

export interface RunnerDeps {
  setting<T = unknown>(key: string): T | undefined;
  keys: KeyStore;
  fetch: FetchLike;
  chatgpt?: DirectProvider;
}

/**
 * ChatGPT plan usage goes straight to the Responses API through OpenAI's documented open-source sign-in
 * (chatgpt-direct.ts). It never runs through Codex, whose threads cannot be limited to the text a request carries.
 */
export const CHATGPT_OFF = "Sign in with ChatGPT is not available in this build. Choose another provider in Settings > AI.";

const MAX_CHARS = 2_500_000;
const DEFAULT_MAX_TOKENS = 4096;
const MAX_TOKENS = 16_000;

/** The renderer picks the answer length; a bad or huge value must not become a runaway bill. */
function clampTokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), MAX_TOKENS) : DEFAULT_MAX_TOKENS;
}
/** How much script text fits: Ollama runs with a 16k-token window, the cloud models have far more. */
const CONTEXT_CHARS: Record<ProviderId, number> = { ollama: 36_000, anthropic: 400_000, google: 400_000, openai: 300_000, chatgpt: 300_000 };

export class AiRunner {
  private readonly active = new Map<string, AbortController>();
  private readonly sessionCleanup = new Map<string, () => void>();
  private ollamaModels: { at: number; models: { name: string; size?: number }[] } | undefined;
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  provider(): ProviderId {
    const chosen = this.deps.setting<string>(AI_SETTINGS.provider);
    return (PROVIDERS as readonly string[]).includes(chosen ?? "") ? (chosen as ProviderId) : "ollama";
  }

  private endpoint(): string {
    const value = this.deps.setting<string>(AI_SETTINGS.ollamaEndpoint)?.trim();
    return value || DEFAULT_OLLAMA_ENDPOINT;
  }

  private chosenModel(provider: ProviderId): string | undefined {
    return this.deps.setting<string>(AI_SETTINGS.model(provider))?.trim() || undefined;
  }

  private async installedOllama(signal: AbortSignal): Promise<{ name: string; size?: number }[]> {
    if (this.ollamaModels && Date.now() - this.ollamaModels.at < 30_000) return this.ollamaModels.models;
    const listed = await listModels("ollama", { ollamaEndpoint: this.endpoint() }, this.deps.fetch, signal);
    const models = listed.map((m) => ({ name: m.id, ...(m.size ? { size: m.size } : {}) }));
    this.ollamaModels = { at: Date.now(), models };
    return models;
  }

  /** The model a request will use: the one chosen in Settings, else the provider's default for the tier. */
  async model(provider: ProviderId, tier: AiTier, signal: AbortSignal): Promise<string> {
    const chosen = this.chosenModel(provider);
    if (provider === "chatgpt") {
      const models = await this.direct().models(signal);
      if (chosen && !models.some((model) => model.id === chosen)) throw new AiError("not-configured", "The chosen ChatGPT model is no longer available. Choose a model in Settings > AI.");
      const model = chosen ?? models[0]?.id;
      if (!model) throw new AiError("not-configured", "This ChatGPT account has no available models.");
      return model;
    }
    if (chosen) return chosen;
    if (provider !== "ollama") return DEFAULT_MODELS[provider][tier];
    const picked = pickOllamaModel(await this.installedOllama(signal));
    if (!picked) throw new AiError("not-configured", "Ollama has no models installed. Run `ollama pull qwen3.5:4b`, or choose another provider in Settings.");
    return picked;
  }

  private direct(): DirectProvider {
    if (!this.deps.chatgpt) throw new AiError("not-configured", CHATGPT_OFF);
    return this.deps.chatgpt;
  }

  private keyFor(provider: ProviderId): string | undefined {
    if (!isKeyedProvider(provider)) return undefined;
    const key = this.deps.keys.get(provider);
    if (!key) throw new AiError("not-configured", `No API key is set for ${provider}. Add one in Settings, under AI.`);
    return key;
  }

  async start(owner: string, request: AiRequest, emit: (event: AiEvent) => void): Promise<AiStarted> {
    if (!request || typeof request.id !== "string" || !request.id) throw new AiError("failed", "A request needs an ID.");
    if (typeof request.system !== "string") throw new AiError("failed", "A request needs instructions.");
    const messages = Array.isArray(request.messages) ? request.messages.filter((m) => !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") : [];
    if (!messages.length || messages[0]!.role !== "user") throw new AiError("failed", "A request needs a first message from the writer.");
    if (request.system.length + messages.reduce((n, m) => n + m.content.length, 0) > MAX_CHARS) throw new AiError("failed", "That request is too large to send.");
    const key = `${owner}:${request.id}`;
    if (this.active.has(key)) throw new AiError("failed", "That request is already running.");
    const provider = (PROVIDERS as readonly string[]).includes(request.provider ?? "") ? request.provider! : this.provider();
    if (provider === "chatgpt") this.direct();
    const controller = new AbortController();
    const accountSignal = provider === "chatgpt" ? this.direct().signal : undefined;
    if (accountSignal) {
      const cancel = () => controller.abort();
      accountSignal.addEventListener("abort", cancel, { once: true });
      this.sessionCleanup.set(key, () => accountSignal.removeEventListener("abort", cancel));
    }
    this.active.set(key, controller);
    try {
      const tier = request.tier === "smart" ? "smart" : "fast";
      const model = await this.model(provider, tier, controller.signal);
      const apiKey = this.keyFor(provider);
      let system = request.system;
      if (request.backlot) system += await this.backlotSection();
      if (controller.signal.aborted) throw new AiError("cancelled", "Cancelled.");
      const chat = { model, tier, system, messages, maxTokens: clampTokens(request.maxTokens), json: !!request.json } as const;
      void this.run(key, provider, chat, apiKey, request.id, emit);
      return { id: request.id, provider, model };
    } catch (error) {
      this.sessionCleanup.get(key)?.();
      this.sessionCleanup.delete(key);
      this.active.delete(key);
      throw error;
    }
  }

  private async backlotSection(): Promise<string> {
    const path = this.deps.setting<string>(AI_SETTINGS.backlotPath);
    if (!path) return "";
    try {
      const summary = await readBacklot(path);
      return `\n\nProduction data from the Backlot project (read-only):\n${summary.text}`;
    } catch (error) {
      return `\n\n(The Backlot project could not be read: ${error instanceof Error ? error.message : String(error)})`;
    }
  }

  private async run(
    key: string, provider: ProviderId, chat: Parameters<typeof streamChat>[1], apiKey: string | undefined, id: string,
    emit: (event: AiEvent) => void,
  ): Promise<void> {
    const controller = this.active.get(key)!;
    const onDelta = (text: string) => emit({ id, type: "delta", text });
    try {
      const text = provider === "chatgpt"
        ? await this.direct().stream(chat, controller.signal)
        : await streamChat(provider, chat, { ollamaEndpoint: this.endpoint(), ...(apiKey ? { apiKey } : {}) }, this.deps.fetch, controller.signal, onDelta);
      emit({ id, type: "done", text });
    } catch (error) {
      const failure = error instanceof AiError ? error : new AiError("failed", error instanceof Error ? error.message : String(error));
      emit({ id, type: "error", message: failure.message, code: failure.code });
    } finally {
      this.sessionCleanup.get(key)?.();
      this.sessionCleanup.delete(key);
      this.active.delete(key);
    }
  }

  cancel(owner: string, id: string): void {
    this.active.get(`${owner}:${id}`)?.abort();
  }

  cancelOwner(owner: string): void {
    for (const [key, controller] of this.active) if (key.startsWith(`${owner}:`)) controller.abort();
  }

  async status(): Promise<AiStatus> {
    const selected = this.provider();
    const chatgpt: ChatgptStatus = this.deps.chatgpt?.status()
      ?? { available: false, signedIn: false, pending: false, note: CHATGPT_OFF };
    const providers = PROVIDERS.map((provider) => {
      if (provider === "chatgpt") return { provider, ready: chatgpt.signedIn && !!chatgpt.planUsageGranted && !chatgpt.paused, note: chatgpt.note };
      if (provider === "ollama") return { provider, ready: true };
      const keySet = this.deps.keys.has(provider);
      return { provider, ready: keySet, keySet, ...(keySet ? {} : { note: "Add an API key." }) };
    });
    return { encryption: this.deps.keys.encryption, providers, chatgpt, active: { provider: selected, model: this.chosenModel(selected) ?? "", contextChars: CONTEXT_CHARS[selected] } };
  }

  async models(provider: ProviderId): Promise<{ models: string[]; suggested?: string; entries?: { id: string; label: string }[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      if (provider === "chatgpt") {
        const entries = await this.direct().models(controller.signal);
        return { models: entries.map((model) => model.id), entries };
      }
      const apiKey = this.keyFor(provider);
      const listed = await listModels(provider, { ollamaEndpoint: this.endpoint(), ...(apiKey ? { apiKey } : {}) }, this.deps.fetch, controller.signal);
      const names = listed.map((m) => m.id);
      return { models: names, ...(provider === "ollama" ? { suggested: pickOllamaModel(listed.map((m) => ({ name: m.id, ...(m.size ? { size: m.size } : {}) }))) ?? undefined } : {}) };
    } finally {
      clearTimeout(timer);
    }
  }

  async test(provider: ProviderId): Promise<AiTestResult> {
    try {
      if (provider === "chatgpt") {
        const { models } = await this.models(provider);
        return { ok: models.length > 0, message: models.length ? "Connected. ChatGPT plan usage is enabled." : "This account has no available models." };
      }
      const { models } = await this.models(provider);
      this.ollamaModels = undefined;
      if (provider === "ollama") {
        const chosen = this.chosenModel("ollama");
        if (!models.length) return { ok: false, message: "Ollama is running but has no models. Run `ollama pull qwen3.5:4b`." };
        if (chosen && !models.includes(chosen)) return { ok: false, message: `Ollama is running, but ${chosen} is not installed.` };
        const used = chosen ?? pickOllamaModel(models.map((name) => ({ name }))) ?? models[0]!;
        return { ok: true, message: `Connected. ${models.length} model${models.length === 1 ? "" : "s"} installed.`, model: used };
      }
      return { ok: true, message: `Connected. The key works (${models.length} models listed).` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  setKey(provider: string, key: string): void {
    if (!isKeyedProvider(provider)) throw new Error("That provider does not use a key.");
    this.deps.keys.set(provider, key);
  }

  clearKey(provider: string): void {
    if (!isKeyedProvider(provider)) throw new Error("That provider does not use a key.");
    this.deps.keys.clear(provider);
  }
}

