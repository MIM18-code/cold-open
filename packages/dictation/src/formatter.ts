// Local model formatter: Ollama or an OpenAI-compatible server on loopback only,
// no SDK credentials and no cloud fallback. Port of Writers Block's providers.py.

import { readFileSync } from "node:fs";

import { type Proposal, generationSchema } from "./models.ts";
import { dropUnanchoredOmissions, parseProposal, sourceErrors } from "./validation.ts";

export class ProviderError extends Error {}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface FormatterSettings {
  provider: "ollama" | "compatible";
  endpoint: string;
  model: string;
  localServerConfirmed: boolean;
  outputMode?: "schema" | "json" | "prompt";
  timeoutSeconds?: number;
  maxOutputTokens?: number;
  ollamaDisableThinking?: boolean;
  /** Bearer token for an authenticated LOCAL server only. */
  token?: string;
}

/** Anything that turns a transcript into a screenplay proposal: local model, cloud, or a fixture. */
export interface Formatter {
  format(transcript: string, context: Record<string, unknown>, signal?: AbortSignal): Promise<Proposal>;
}

const PROMPT = readFileSync(new URL("./format_scene.txt", import.meta.url), "utf8");

export function looksCloudModel(name: string): boolean {
  return /(^|[:/_.-])cloud($|[:/_.-])/i.test(name);
}

/** Loopback only, and never resolve "localhost": no DNS rebinding to a cloud endpoint. */
export function localEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError("Invalid model endpoint.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ProviderError("The endpoint must use HTTP or HTTPS on loopback.");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new ProviderError("Only 127.0.0.1, localhost, and ::1 model servers are allowed.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderError("Credentials, query strings and fragments are not allowed in endpoints.");
  }
  if (url.pathname.includes("..") || url.pathname.includes("%") || url.pathname.includes("\\")) {
    throw new ProviderError("Invalid endpoint path.");
  }
  const host = url.hostname === "[::1]" ? "[::1]" : "127.0.0.1";
  return `${url.protocol}//${host}${url.port ? ":" + url.port : ""}${url.pathname.replace(/\/+$/, "")}`;
}

/** Why this model may not be sent to the local server, or an empty string. */
export function localModelError(s: FormatterSettings): string {
  if (!s.model) return "Select a local model in Settings first.";
  if (looksCloudModel(s.model)) return "Cloud-tagged model IDs are blocked. Use downloaded local weights.";
  if (!s.localServerConfirmed) {
    return "Confirm in Model settings that the server runs local weights. "
      + "For Ollama, disable cloud features in the actual server process first; "
      + "localhost alone does not guarantee local inference.";
  }
  return "";
}

/** json.dumps(value, ensure_ascii=False): the exact bytes Writers Block sends, so prompts match. */
export function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(pythonJson).join(", ") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ": " + pythonJson(v)).join(", ") + "}";
  }
  return JSON.stringify(value);
}

export function buildMessages(transcript: string, context: Record<string, unknown>): ChatMessage[] {
  const envelope = { context, current_transcript: transcript, output_schema: generationSchema() };
  return [{ role: "system", content: PROMPT }, { role: "user", content: pythonJson(envelope) }];
}

// Ollama's default context can be far below what a long take needs, and it drops
// the front of the prompt (the instructions) rather than refusing. Every request
// names its window, and only two sizes exist: Ollama rebuilds the runner when it changes.
export const CONTEXT_WINDOW = 16384;
export const CONTEXT_CEILING = 32768;

export function contextWindow(messages: ChatMessage[], outputTokens: number): number {
  const characters = messages.reduce((sum, m) => sum + Array.from(m.content).length, 0);
  const needed = Math.floor(characters / 3) + outputTokens; // three characters per token is a cautious estimate
  if (needed <= CONTEXT_WINDOW) return CONTEXT_WINDOW;
  if (needed <= CONTEXT_CEILING) return CONTEXT_CEILING;
  throw new ProviderError("This take and its context exceed the local model window this app allows. "
    + "Dictate a shorter take or trim the project context.");
}

export class LocalFormatter implements Formatter {
  private readonly endpoint: string;
  private readonly settings: Required<Omit<FormatterSettings, "token">> & { token?: string };

  private readonly fetcher: typeof fetch;

  constructor(settings: FormatterSettings, fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
    this.settings = {
      outputMode: "schema", timeoutSeconds: 180, maxOutputTokens: 6000, ollamaDisableThinking: false, ...settings,
    };
    this.endpoint = localEndpoint(settings.endpoint);
  }

  private async request(path: string, payload?: unknown, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.settings.token) headers.authorization = "Bearer " + this.settings.token;
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint + path, {
        method: payload === undefined ? "GET" : "POST",
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.settings.timeoutSeconds * 1000)]) : AbortSignal.timeout(this.settings.timeoutSeconds * 1000),
      });
    } catch (error) {
      throw new ProviderError(`Could not use the local model server: ${(error as Error).message}`);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      throw new ProviderError("Local model server returned a redirect; redirects are blocked.");
    }
    if (response.status >= 400) {
      throw new ProviderError(`Local model server returned HTTP ${response.status}. No cloud fallback was used. `
        + (await response.text()).slice(0, 600));
    }
    try {
      return await response.json();
    } catch (error) {
      throw new ProviderError(`Could not use the local model server: ${(error as Error).message}`);
    }
  }

  /** Ask Ollama to load the model now, with no prompt, so the take formats warm. */
  async warm(): Promise<boolean> {
    if (this.settings.provider !== "ollama" || localModelError(this.settings)) return false;
    await this.request("/api/generate", { model: this.settings.model, keep_alive: "5m", options: { num_ctx: CONTEXT_WINDOW } });
    return true;
  }

  async models(): Promise<string[]> {
    if (this.settings.provider === "ollama") {
      const data = await this.request("/api/tags");
      return (data.models ?? []).filter((m: any) => m.name && !looksCloudModel(m.name) && !m.remote_host).map((m: any) => m.name);
    }
    const data = await this.request("/models");
    return (data.data ?? []).filter((m: any) => m.id && !looksCloudModel(m.id)).map((m: any) => m.id);
  }

  async complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const s = this.settings;
    const blocked = localModelError(s);
    if (blocked) throw new ProviderError(blocked);
    let text: unknown;
    if (s.provider === "ollama") {
      const payload: Record<string, unknown> = {
        model: s.model, messages, stream: false, keep_alive: "30m",
        options: { temperature: 0, num_predict: s.maxOutputTokens, num_ctx: contextWindow(messages, s.maxOutputTokens) },
      };
      if (s.outputMode !== "prompt") payload.format = s.outputMode === "schema" ? generationSchema() : "json";
      if (s.ollamaDisableThinking) payload.think = false;
      const data = await this.request("/api/chat", payload, signal);
      if (data.done_reason === "length" || data.done === false) {
        throw new ProviderError("Generation was truncated. Dictate a shorter take or raise the output limit.");
      }
      text = data.message?.content;
    } else {
      const payload: Record<string, unknown> = { model: s.model, messages, stream: false, temperature: 0, max_tokens: s.maxOutputTokens };
      if (s.outputMode === "schema") {
        payload.response_format = { type: "json_schema", json_schema: { name: "screenplay_take", strict: true, schema: generationSchema() } };
      } else if (s.outputMode === "json") {
        payload.response_format = { type: "json_object" };
      }
      const data = await this.request("/chat/completions", payload, signal);
      const choice = data.choices?.[0];
      if (!choice) throw new ProviderError("Model server returned no choices.");
      if (choice.finish_reason === "length") {
        throw new ProviderError("Generation was truncated. No partial output was accepted; use a shorter take or higher output limit.");
      }
      if (["tool_calls", "content_filter"].includes(choice.finish_reason)) {
        throw new ProviderError("The local server did not return a screenplay proposal.");
      }
      text = choice.message?.content;
    }
    if (typeof text !== "string" || !text.trim()) throw new ProviderError("Model returned no text. Check its chat template/thinking settings.");
    if (text.length > 250000) throw new ProviderError("Model response is unexpectedly large.");
    return text;
  }

  async format(transcript: string, context: Record<string, unknown>, signal?: AbortSignal): Promise<Proposal> {
    const messages = buildMessages(transcript, context);
    let lastError = "";
    // One bounded retry for schema/source anchoring only; never an agent loop.
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const raw = await this.complete(messages, signal);
      signal?.throwIfAborted();
      try {
        const proposal = dropUnanchoredOmissions(parseProposal(raw), transcript);
        const errors = sourceErrors(proposal, transcript);
        if (errors.length) throw new Error(errors.slice(0, 6).join(" "));
        return proposal;
      } catch (error) {
        lastError = (error as Error).message;
        if (attempt === 0) {
          messages.push({ role: "assistant", content: raw.slice(0, 50000) },
            { role: "user", content: "Repair only the invalid structure/source anchoring. "
              + "Do not rewrite the screenplay. Return the entire JSON object. Validation: " + lastError.slice(0, 2000) });
        }
      }
    }
    throw new ProviderError("The local model failed schema/source validation twice. Your transcript is saved. " + lastError.slice(0, 1000));
  }
}
