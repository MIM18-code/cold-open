// Runs AI requests: picks the provider and model from settings, adds the API key and the Backlot summary,
// streams the answer back as events and supports cancelling. Everything it needs comes in through RunnerDeps,
// so tests can supply fake transports and account state.
import { createHash } from "node:crypto";
import {
  AI_SETTINGS, type ChatgptStatus, DEFAULT_OLLAMA_ENDPOINT, PROVIDERS, type AiEvent, type AiModelList, type AiRequest, type AiStarted, type AiStatus, type AiTestResult,
  type AiTier, type KeyedProvider, type ProviderId, type ProductionData,
} from "../../shared/channels/ai.ts";
import { readBacklot } from "./backlot.ts";
import { localAiSetup } from "./local-setup.ts";
import type { LocalAiSetup } from "../../shared/channels/ai.ts";
import type { DirectProvider } from "./chatgpt-direct.ts";
import { isKeyedProvider, type KeyStore } from "./keys.ts";
import {
  AiError, DEFAULT_MODELS, type FetchLike, type HttpProvider, listModels, newestModel, pickOllamaModel, streamChat, toolChat,
} from "./providers.ts";
import { validateMessages, validateTools } from "./tool-calls.ts";

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

/** Automatic picks follow the provider's list; it changes rarely, and a failed list must not be retried per request. */
const LIST_TTL_MS = 6 * 60 * 60_000;
const LIST_RETRY_MS = 5 * 60_000;
/** Short, because the writer's request waits on it; the built-in model is the answer after this. */
const LIST_TIMEOUT_MS = 4000;

interface ModelListCache {
  /** A digest of the key the list was fetched with, so a new key fetches again and no key sits in the cache. */
  key: string;
  until: number;
  ids: string[];
  pending?: Promise<string[]>;
}

const digest = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex");

/** Waits for a shared promise, but gives up as cancelled when this request is. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AiError("cancelled", "Cancelled."));
  return new Promise((resolve, reject) => {
    const stop = () => reject(new AiError("cancelled", "Cancelled."));
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** The provider answered with an HTTP error the built-in model might not get: a refused parameter, a model this key
 * cannot use, a new model that is down. Not the key or a limit, which the built-in would hit too. */
function refusedRequest(error: unknown): boolean {
  if (!(error instanceof AiError) || error.status === undefined) return false;
  // A 5xx that says "overloaded" is classified as a limit, but it is the model's trouble, not the account's.
  if (error.status >= 500) return true;
  return error.code !== "unauthorized" && error.code !== "rate-limited" && error.status !== 408;
}

export class AiRunner {
  private readonly active = new Map<string, AbortController>();
  private readonly sessionCleanup = new Map<string, () => void>();
  private ollamaModels: { at: number; endpoint: string; models: { name: string; size?: number }[] } | undefined;
  private readonly deps: RunnerDeps;
  private readonly lists = new Map<KeyedProvider, ModelListCache>();
  /** Automatic picks a provider refused, as `provider\0model`; not picked again until the app restarts. */
  private readonly refused = new Set<string>();

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
    if (this.ollamaModels?.endpoint === this.endpoint() && Date.now() - this.ollamaModels.at < 30_000 && this.ollamaModels.models.length) return this.ollamaModels.models;
    const listed = await listModels("ollama", { ollamaEndpoint: this.endpoint() }, this.deps.fetch, signal);
    const models = listed.map((m) => ({ name: m.id, ...(m.size ? { size: m.size } : {}) }));
    this.ollamaModels = { at: Date.now(), endpoint: this.endpoint(), models };
    return models;
  }

  private remember(provider: KeyedProvider, key: string, ids: string[]): string[] {
    this.lists.set(provider, { key, until: Date.now() + LIST_TTL_MS, ids });
    return ids;
  }

  /** The provider's model IDs, cached per key. Concurrent requests share one fetch; a failure gives an empty list. */
  private listed(provider: KeyedProvider, apiKey: string, signal: AbortSignal): Promise<string[]> {
    const key = digest(apiKey);
    const cached = this.lists.get(provider);
    if (cached?.key === key && cached.pending) return untilAborted(cached.pending, signal);
    if (cached?.key === key && Date.now() < cached.until) return Promise.resolve(cached.ids);
    // Not tied to one request's signal: the fetch is shared, and its answer serves the next requests too.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), LIST_TIMEOUT_MS);
    const entry: ModelListCache = { key, until: 0, ids: [] };
    entry.pending = listModels(provider, { ollamaEndpoint: "", apiKey }, this.deps.fetch, timeout.signal).then(
      (models) => this.remember(provider, key, models.map((m) => m.id)),
      () => {
        entry.until = Date.now() + LIST_RETRY_MS;
        entry.pending = undefined;
        return [];
      },
    ).finally(() => clearTimeout(timer));
    this.lists.set(provider, entry);
    return untilAborted(entry.pending, signal);
  }

  private pick(provider: KeyedProvider, tier: AiTier, ids: readonly string[]): string {
    return newestModel(provider, tier, ids.filter((id) => !this.refused.has(`${provider}\0${id}`)));
  }

  /** The newest model in the tier's line that the key lists, else the built-in. Without a key, the built-in. */
  private async automatic(provider: KeyedProvider, tier: AiTier, signal: AbortSignal): Promise<string> {
    const apiKey = this.deps.keys.get(provider);
    if (!apiKey) return DEFAULT_MODELS[provider][tier];
    return this.pick(provider, tier, await this.listed(provider, apiKey, signal));
  }

  /** The model a request will use: the one chosen in Settings, else the automatic pick for the tier. */
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
    if (provider !== "ollama") return this.automatic(provider, tier, signal);
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
    const tools = validateTools(request.tools);
    const messages = validateMessages(request.messages, tools);
    if (request.system.length + JSON.stringify({ messages, tools }).length > MAX_CHARS) throw new AiError("failed", "That request is too large to send.");
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
      const builtin = isKeyedProvider(provider) && !this.chosenModel(provider) ? DEFAULT_MODELS[provider][tier] : undefined;
      const model = await this.model(provider, tier, controller.signal);
      const apiKey = this.keyFor(provider);
      let system = request.system;
      if (request.backlot) system += await this.backlotSection();
      if (controller.signal.aborted) throw new AiError("cancelled", "Cancelled.");
      const chat = { model, tier, system, messages, maxTokens: clampTokens(request.maxTokens), json: !!request.json, ...(tools ? { tools } : {}) } as const;
      void this.run(key, provider, chat, apiKey, request.id, emit, builtin !== model ? builtin : undefined);
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

  async productionData(): Promise<ProductionData> {
    const path = this.deps.setting<string>(AI_SETTINGS.backlotPath);
    if (!path) return { ok: false, error: "No Backlot project is set." };
    try { return { ok: true, text: (await readBacklot(path)).text }; }
    catch { return { ok: false, error: "The Backlot project could not be read." }; }
  }

  private async run(
    key: string, provider: ProviderId, chat: Parameters<typeof streamChat>[1], apiKey: string | undefined, id: string,
    emit: (event: AiEvent) => void, fallback?: string,
  ): Promise<void> {
    const controller = this.active.get(key)!;
    let sent = false;
    const onDelta = (text: string) => {
      sent = true;
      emit({ id, type: "delta", text });
    };
    const config = { ollamaEndpoint: this.endpoint(), ...(apiKey ? { apiKey } : {}) };
    // A newer automatic pick can reject a parameter older models accept. Before any text reaches the writer, send
    // once more with the built-in model. If that works the pick was the problem, so stop picking it; if it fails
    // too, the request was.
    const orFallback = async <T>(send: (model: string) => Promise<T>): Promise<T> => {
      try {
        return await send(chat.model);
      } catch (error) {
        if (!fallback || sent || controller.signal.aborted || !refusedRequest(error)) throw error;
        const answer = await send(fallback);
        this.refused.add(`${provider}\0${chat.model}`);
        return answer;
      }
    };
    try {
      if (chat.tools?.length) {
        const direct = provider === "chatgpt" ? this.direct() : undefined;
        if (direct && !direct.turn) throw new AiError("failed", "ChatGPT tools are unavailable.");
        const turn = direct
          ? await direct.turn!(chat, controller.signal)
          : await orFallback((model) => toolChat(provider as HttpProvider, { ...chat, model }, config, this.deps.fetch, controller.signal));
        if (controller.signal.aborted) throw new AiError("cancelled", "Cancelled.");
        emit({ id, type: "done", ...turn });
        return;
      }
      const text = provider === "chatgpt"
        ? await this.direct().stream(chat, controller.signal)
        : await orFallback((model) => streamChat(provider as HttpProvider, { ...chat, model }, config, this.deps.fetch, controller.signal, onDelta));
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

  private probe: { key: string; at: number; value?: LocalAiSetup; pending?: Promise<LocalAiSetup> } | undefined;
  /** The local model's readiness, checked at most every 5 s per endpoint and model, and once at a time. With `cached`,
   * returns the last answer (or undefined) without waiting and refreshes in the background. */
  localReadiness(): Promise<LocalAiSetup>;
  localReadiness(cached: true): LocalAiSetup | undefined;
  /** `fresh` is the setup sheet's check: it always probes, so a retry after setup reads what the sheet just saw. */
  localReadiness(cached: "fresh"): Promise<LocalAiSetup>;
  localReadiness(cached: boolean | "fresh" = false): Promise<LocalAiSetup> | LocalAiSetup | undefined {
    const selected = this.chosenModel("ollama"), key = `${this.endpoint()}\0${selected ?? ""}`;
    if (this.probe?.key !== key) this.probe = { key, at: 0 };
    const probe = this.probe;
    if (!probe.pending && (cached === "fresh" || Date.now() - probe.at > 5000)) {
      probe.pending = localAiSetup(this.endpoint(), { fetch: this.deps.fetch, ...(selected ? { selected } : {}) })
        .then((value) => (probe.value = value, probe.at = Date.now(), value)).finally(() => { probe.pending = undefined; });
      probe.pending.catch(() => undefined);
    }
    if (cached === true) return probe.value;
    return probe.pending ?? Promise.resolve(probe.value!);
  }

  async status(): Promise<AiStatus> {
    const selected = this.provider();
    const chatgpt: ChatgptStatus = this.deps.chatgpt?.status()
      ?? { available: false, signedIn: false, pending: false, note: CHATGPT_OFF };
    // Only the local model's own requests wait for the probe; a cloud request reads the last answer.
    const local = selected === "ollama" ? await this.localReadiness() : this.localReadiness(true);
    const providers = PROVIDERS.map((provider) => {
      if (provider === "chatgpt") return { provider, ready: chatgpt.signedIn && !!chatgpt.planUsageGranted && !chatgpt.paused, note: chatgpt.note };
      if (provider === "ollama") return { provider, ready: local ? local.running && local.model : true };
      const keySet = this.deps.keys.has(provider);
      return { provider, ready: keySet, keySet, ...(keySet ? {} : { note: "Add an API key." }) };
    });
    return { encryption: this.deps.keys.encryption, providers, chatgpt, active: { provider: selected, model: this.chosenModel(selected) ?? "", contextChars: CONTEXT_CHARS[selected] } };
  }

  async models(provider: ProviderId): Promise<AiModelList> {
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
      if (isKeyedProvider(provider) && apiKey) {
        this.remember(provider, digest(apiKey), names);
        return { models: names, automatic: { fast: this.pick(provider, "fast", names), smart: this.pick(provider, "smart", names) } };
      }
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

