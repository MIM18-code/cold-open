// The HTTP providers: Ollama, Anthropic, Google and OpenAI. Plain fetch, no SDKs. Each provider has a request
// builder and a parser for one streamed event, both pure so tests can run them against canned responses.
import type { AiErrorCode, AiMessage, AiTier, ProviderId } from "../../shared/channels/ai.ts";
import { type SseEvent, readLines, readSse } from "./stream.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type HttpProvider = Exclude<ProviderId, "chatgpt">;

export class AiError extends Error {
  readonly code: AiErrorCode;
  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Defaults, overridable in Settings. Anthropic and Google IDs are from the product brief; OpenAI IDs are unchecked against a live key. */
export const DEFAULT_MODELS: Record<Exclude<ProviderId, "ollama" | "chatgpt">, Record<AiTier, string>> = {
  anthropic: { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5" },
  google: { fast: "gemini-3.8-flash", smart: "gemini-3.8-flash" },
  openai: { fast: "gpt-6-luna", smart: "gpt-6.1-sol" },
};

/** Ollama models worth using for proofreading and questions, best first. */
const OLLAMA_PREFERENCE = [/^qwen3\.5/, /^gemma4/, /^qwen3/, /^gemma3/, /^llama3\.[123]/, /^phi4/, /^mistral/];

export interface InstalledModel {
  name: string;
  size?: number;
}

/** The best small model Ollama has installed: the preferred families in order, else the largest under 8 GB. */
export function pickOllamaModel(installed: readonly InstalledModel[]): string | null {
  const usable = installed.filter((m) => !/embed|rerank/i.test(m.name));
  for (const pattern of OLLAMA_PREFERENCE) {
    const match = usable.filter((m) => pattern.test(m.name)).sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0];
    if (match) return match.name;
  }
  const small = usable.filter((m) => (m.size ?? 0) <= 8e9).sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
  return (small ?? usable.sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0])?.name ?? null;
}

export interface ChatRequest {
  model: string;
  tier: AiTier;
  system: string;
  messages: AiMessage[];
  maxTokens: number;
  json: boolean;
}

export interface ProviderConfig {
  ollamaEndpoint: string;
  apiKey?: string;
}

export interface BuiltRequest {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
}

const JSON_HEADERS = { "content-type": "application/json" };

export function buildRequest(provider: HttpProvider, request: ChatRequest, config: ProviderConfig): BuiltRequest {
  const key = config.apiKey ?? "";
  switch (provider) {
    case "ollama":
      return {
        url: `${config.ollamaEndpoint.replace(/\/+$/, "")}/api/chat`,
        init: {
          method: "POST", headers: JSON_HEADERS,
          body: JSON.stringify({
            model: request.model,
            messages: [{ role: "system", content: request.system }, ...request.messages],
            stream: true,
            // Thinking models spend minutes reasoning before the first word; proofreading and answers don't need it.
            think: false,
            ...(request.json ? { format: "json" } : {}),
            // Ollama's default window is 4096 tokens, which cuts a script off silently.
            options: { temperature: 0.2, num_predict: request.maxTokens, num_ctx: 16384 },
            keep_alive: "30m",
          }),
        },
      };
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        init: {
          method: "POST", headers: { ...JSON_HEADERS, "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: request.model, max_tokens: request.maxTokens, system: request.system, messages: request.messages, stream: true }),
        },
      };
    case "google":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
        init: {
          method: "POST", headers: { ...JSON_HEADERS, "x-goog-api-key": key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: request.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
            generationConfig: {
              maxOutputTokens: request.maxTokens, temperature: 0.2,
              // Always explicit: Flash models reject "minimal" and a missing level changes with the model.
              thinkingConfig: { thinkingLevel: "high" },
              ...(request.json ? { responseMimeType: "application/json" } : {}),
            },
          }),
        },
      };
    case "openai":
      return {
        url: "https://api.openai.com/v1/responses",
        init: {
          method: "POST", headers: { ...JSON_HEADERS, authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: request.model, instructions: request.system, input: request.messages, stream: true, store: false,
            max_output_tokens: request.maxTokens, ...(request.json ? { text: { format: { type: "json_object" } } } : {}),
          }),
        },
      };
  }
}

export interface Delta {
  text?: string;
  /** The stream finished normally. */
  done?: boolean;
  error?: { code: AiErrorCode; message: string };
}

function parse(data: string): any {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function classify(message: string, status?: number): AiErrorCode {
  if (status === 401 || status === 403 || /api key|unauthori|authenticat|permission/i.test(message)) return "unauthorized";
  if (status === 429 || /rate.?limit|quota|usage limit|overloaded|credit|billing/i.test(message)) return "rate-limited";
  return "failed";
}

/** Read one streamed line (Ollama) or event (the others) into text, a finish or an error. */
export function readDelta(provider: HttpProvider, event: string | SseEvent): Delta {
  const data = parse(typeof event === "string" ? event : event.data);
  if (!data) return {};
  switch (provider) {
    case "ollama":
      if (data.error) return { error: { code: classify(String(data.error)), message: String(data.error) } };
      return { ...(typeof data.message?.content === "string" && data.message.content ? { text: data.message.content } : {}), ...(data.done ? { done: true } : {}) };
    case "anthropic":
      if (data.type === "error") return { error: { code: classify(data.error?.message ?? "", undefined), message: data.error?.message ?? "Anthropic returned an error." } };
      if (data.type === "content_block_delta" && data.delta?.type === "text_delta") return { text: data.delta.text };
      return data.type === "message_stop" ? { done: true } : {};
    case "google": {
      if (data.error) return { error: { code: classify(data.error.message ?? "", data.error.code), message: data.error.message ?? "Google returned an error." } };
      if (data.promptFeedback?.blockReason) return { error: { code: "failed", message: `Google blocked the request (${data.promptFeedback.blockReason}).` } };
      const parts: { text?: string; thought?: boolean }[] = data.candidates?.[0]?.content?.parts ?? [];
      const text = parts.filter((part) => !part.thought && typeof part.text === "string").map((part) => part.text).join("");
      return { ...(text ? { text } : {}), ...(data.candidates?.[0]?.finishReason ? { done: true } : {}) };
    }
    case "openai":
      if (data.type === "response.output_text.delta" && typeof data.delta === "string") return { text: data.delta };
      if (data.type === "response.completed") return { done: true };
      if (data.type === "response.failed" || data.type === "response.incomplete" || data.type === "error") {
        // A stream error event nests its details under "error"; a failed response under "response.error".
        const failure = data.error ?? data.response?.error;
        const message = failure?.message ?? data.response?.incomplete_details?.reason ?? data.message ?? "OpenAI did not finish the answer.";
        return { error: { code: classify(`${failure?.type ?? ""} ${failure?.code ?? ""} ${message}`), message: String(message) } };
      }
      return {};
  }
}

async function failureOf(response: Response, name: string): Promise<AiError> {
  let detail = "";
  try {
    const body = parse(await response.text());
    const raw = body?.error?.message ?? body?.error ?? body?.message;
    detail = typeof raw === "string" ? raw : "";
  } catch {
    // The body is only for the message.
  }
  const code = classify(detail, response.status);
  const base = code === "unauthorized" ? `${name} did not accept the API key.` : code === "rate-limited" ? `${name} says the usage limit was reached.` : `${name} returned ${response.status}.`;
  return new AiError(code, detail ? `${base} ${detail}` : base);
}

const NAMES: Record<HttpProvider, string> = { ollama: "Ollama", anthropic: "Anthropic", google: "Google", openai: "OpenAI" };

async function send(provider: HttpProvider, built: BuiltRequest, fetchFn: FetchLike, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetchFn(built.url, { ...built.init, signal });
  } catch (error) {
    if (signal.aborted) throw new AiError("cancelled", "Cancelled.");
    const reason = error instanceof Error ? error.message : String(error);
    throw new AiError("unreachable", provider === "ollama" ? `Ollama is not running at that address (${reason}).` : `Could not reach ${NAMES[provider]} (${reason}).`);
  }
  if (!response.ok) throw await failureOf(response, NAMES[provider]);
  return response;
}

/** Stream a chat answer. Resolves with the whole text; `onDelta` sees each piece as it arrives. */
export async function streamChat(
  provider: HttpProvider, request: ChatRequest, config: ProviderConfig, fetchFn: FetchLike, signal: AbortSignal, onDelta: (text: string) => void,
): Promise<string> {
  const response = await send(provider, buildRequest(provider, request, config), fetchFn, signal);
  if (!response.body) throw new AiError("bad-response", `${NAMES[provider]} sent no answer.`);
  let text = "";
  let finished = false;
  try {
    const events = provider === "ollama" ? readLines(response.body) : readSse(response.body);
    for await (const event of events) {
      const delta = readDelta(provider, event);
      if (delta.error) throw new AiError(delta.error.code, delta.error.message);
      if (delta.text) {
        text += delta.text;
        onDelta(delta.text);
      }
      if (delta.done) finished = true;
    }
  } catch (error) {
    if (signal.aborted) throw new AiError("cancelled", "Cancelled.");
    if (error instanceof AiError) throw error;
    throw new AiError("unreachable", `The connection to ${NAMES[provider]} dropped: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (signal.aborted) throw new AiError("cancelled", "Cancelled.");
  if (!finished && !text) throw new AiError("bad-response", `${NAMES[provider]} finished without an answer.`);
  return text;
}

export interface ModelEntry {
  id: string;
  size?: number;
}

/** The models a provider offers. Also the cheapest way to test a key: listing costs nothing. */
export async function listModels(provider: HttpProvider, config: ProviderConfig, fetchFn: FetchLike, signal: AbortSignal): Promise<ModelEntry[]> {
  const get = (url: string, headers: Record<string, string>) => send(provider, { url, init: { method: "GET", headers } }, fetchFn, signal);
  const key = config.apiKey ?? "";
  switch (provider) {
    case "ollama": {
      const body = await (await get(`${config.ollamaEndpoint.replace(/\/+$/, "")}/api/tags`, {})).json() as { models?: { name?: string; size?: number }[] };
      return (body.models ?? []).filter((m) => m.name).map((m) => ({ id: m.name!, ...(m.size ? { size: m.size } : {}) }));
    }
    case "anthropic": {
      const body = await (await get("https://api.anthropic.com/v1/models?limit=100", { "x-api-key": key, "anthropic-version": "2023-06-01" })).json() as { data?: { id: string }[] };
      return (body.data ?? []).map((m) => ({ id: m.id }));
    }
    case "google": {
      const body = await (await get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { "x-goog-api-key": key })).json() as
        { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      return (body.models ?? []).filter((m) => m.supportedGenerationMethods?.includes("generateContent")).map((m) => ({ id: m.name.replace(/^models\//, "") }));
    }
    case "openai": {
      const body = await (await get("https://api.openai.com/v1/models", { authorization: `Bearer ${key}` })).json() as { data?: { id: string }[] };
      return (body.data ?? []).map((m) => ({ id: m.id })).filter((m) => /^(gpt|o\d)/.test(m.id));
    }
  }
}
