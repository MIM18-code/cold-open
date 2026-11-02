import { PLAN_LIMIT_MESSAGE, type ChatgptStatus } from "../../shared/channels/ai.ts";
import { boundedChunks, boundedJson, connectionError, diagnosticCode, diagnosticText, object, request, requestIdOf } from "./chatgpt-http.ts";
import type { ChatgptOAuth } from "./chatgpt-oauth.ts";
import { AiError, type ChatRequest, type FetchLike } from "./providers.ts";

export interface ChatgptModel { id: string; label: string }
export interface DirectProvider {
  readonly signal?: AbortSignal;
  status(): ChatgptStatus;
  models(signal: AbortSignal): Promise<ChatgptModel[]>;
  stream(chat: ChatRequest, signal: AbortSignal): Promise<string>;
}

const API = "https://api.openai.com/v1";
const LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";

/** No agent runtime, tools, API-key fallback, or automatic inference retries. */
export class ChatgptDirect implements DirectProvider {
  private active = 0;
  private readonly account: ChatgptOAuth;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  constructor(account: ChatgptOAuth, fetchFn: FetchLike, timeoutMs = 90_000) {
    this.account = account;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  status(): ChatgptStatus { return this.account.status(); }
  get signal(): AbortSignal { return this.account.signal; }

  /**
   * OpenAI's errors-and-recovery guidance: keep the status, error code and request ID; never erase credentials over a
   * 401 or a temporary failure. Only a terminal refresh error (in the account) asks the writer to sign in again.
   */
  /** The finished message with every token the account holds, and the bearer this request used, removed. */
  private redacted(error: AiError, bearer: string): AiError {
    return new AiError(error.code, this.account.redact(error.message, bearer));
  }

  private failure(status: number, raw: Record<string, unknown>, requestId?: string | null): AiError {
    const error = object(raw.error);
    // Status, OpenAI's own code (or an admission "detail"), and the request ID, so a report can be traced.
    const code = diagnosticCode(error.code) || diagnosticText(raw.detail);
    const diagnostics = [status ? `HTTP ${status}` : "", code, requestId ? `request ID ${requestId}` : ""].filter(Boolean).join(", ");
    const tail = diagnostics ? ` (${diagnostics})` : "";
    if (error.code === LIMIT_CODE) {
      this.account.pause();
      return new AiError("plan-limit", `${PLAN_LIMIT_MESSAGE}${tail}. ChatGPT requests are paused. Review your plan or this app's limit in ChatGPT settings, then resume in Settings > AI.`);
    }
    if (status === 401) {
      // Renew once: the next request refreshes first. A 401 right after a renewal is not retried again, because a
      // fresh token that is still refused points at the account or its permission, not at an old token.
      if (this.account.expireAccess()) {
        return new AiError("unauthorized", `ChatGPT did not accept the access token${tail}. Try again: Cold Open renews access first.`);
      }
      return new AiError("unauthorized", `ChatGPT still refuses this account${tail}. Check its plan permission in ChatGPT, or sign out and continue with ChatGPT again.`);
    }
    if (error.code === "subscription_sharing_unsupported_capability") {
      const param = diagnosticText(error.param) || "part of this request";
      return new AiError("bad-response", `ChatGPT plan usage does not support ${param}${tail}. Choose another model or provider.`);
    }
    if (error.code === "subscription_sharing_user_not_eligible") {
      return new AiError("unauthorized", `This account or workspace is not eligible for ChatGPT plan usage${tail}. Choose another provider in Settings > AI.`);
    }
    if (status === 403) return new AiError("unauthorized", `ChatGPT did not permit this request${tail}. Check the account's plan permission and serving region.`);
    if (status === 429) return new AiError("rate-limited", `ChatGPT is rate limiting requests${tail}. Try again later.`);
    if (error.code === "subscription_sharing_usage_unavailable" || status >= 500) {
      return new AiError("unreachable", `ChatGPT plan usage is temporarily unavailable${tail}. Try again later.`);
    }
    return new AiError("bad-response", `ChatGPT did not complete the request${tail}. Try again or choose another provider.`);
  }

  async models(caller: AbortSignal): Promise<ChatgptModel[]> {
    const signal = AbortSignal.any([caller, this.account.signal, AbortSignal.timeout(10_000)]);
    try {
      const token = await this.account.accessToken(signal);
      signal.throwIfAborted();
      const response = await request(this.fetchFn, `${API}/models`, { method: "GET", headers: { authorization: `Bearer ${token}` } }, signal);
      const data = await boundedJson(response, signal);
      signal.throwIfAborted();
      if (!response.ok) throw this.redacted(this.failure(response.status, data, requestIdOf(response)), token);
      if (!Array.isArray(data.models)) throw new AiError("bad-response", "ChatGPT returned no model catalog.");
      return data.models.map(object).filter((m) => m.visibility === "list" && typeof m.slug === "string" && typeof m.display_name === "string")
        .map((m) => ({ id: m.slug as string, label: m.display_name as string }));
    } catch (error) { throw connectionError(signal, error); }
  }

  async stream(chat: ChatRequest, caller: AbortSignal): Promise<string> {
    if (this.active >= 2) throw new AiError("rate-limited", "Two ChatGPT requests are already running. Wait for one to finish.");
    const body = JSON.stringify({ model: chat.model, store: false, stream: true,
      input: [{ role: "developer", content: chat.system + (chat.json ? "\nReturn one valid JSON object." : "") }, ...chat.messages] });
    if (Buffer.byteLength(body) > 400_000) throw new AiError("failed", "That ChatGPT request is too large. Send a smaller passage.");
    const signal = AbortSignal.any([caller, this.account.signal, AbortSignal.timeout(this.timeoutMs)]);
    this.active++;
    try {
      const token = await this.account.accessToken(signal);
      signal.throwIfAborted();
      const response = await request(this.fetchFn, `${API}/responses`, { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body }, signal);
      if (!response.ok) {
        const data = await boundedJson(response, signal);
        signal.throwIfAborted();
        throw this.redacted(this.failure(response.status, data, requestIdOf(response)), token);
      }
      if (!response.body) throw new AiError("bad-response", "ChatGPT returned no response stream.");
      let buffer = "", text = "", completed = false;
      const decoder = new TextDecoder();
      for await (const chunk of boundedChunks(response.body, signal, 2 * 1024 * 1024)) {
        buffer += decoder.decode(chunk, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data || data === "[DONE]") continue;
          let event: Record<string, unknown>;
          try { event = object(JSON.parse(data)); }
          catch { throw new AiError("bad-response", "ChatGPT returned an invalid stream event."); }
          if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
            signal.throwIfAborted();
            const failure = object(event.response);
            throw this.redacted(this.failure(response.status, event.type === "error" ? { error: event.error ?? event } : failure, requestIdOf(response)), token);
          }
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
          if (event.type === "response.completed") {
            const terminal = object(event.response);
            if (terminal.status !== undefined && terminal.status !== "completed") {
              throw new AiError("bad-response", "ChatGPT did not finish the answer.");
            }
            completed = true;
            break;
          }
        }
        if (completed) break;
      }
      signal.throwIfAborted();
      if (!completed) throw new AiError("bad-response", "ChatGPT stream ended before completion. No result was used.");
      if (!text.trim()) throw new AiError("bad-response", "ChatGPT completed without an answer.");
      if (chat.json) {
        let value: unknown;
        try { value = JSON.parse(text); }
        catch { throw new AiError("bad-response", "ChatGPT completed with invalid JSON. No result was used."); }
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new AiError("bad-response", "ChatGPT did not return a JSON object.");
        }
      }
      this.account.accessWorked();
      return text;
    } catch (error) { throw connectionError(signal, error); }
    finally { this.active--; }
  }
}
