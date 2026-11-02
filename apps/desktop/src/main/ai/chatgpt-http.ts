import { AiError, type FetchLike } from "./providers.ts";

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Also bounds bodies without newlines, and cancels a stalled reader on timeout or sign-out. */
export async function* boundedChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal, limit: number) {
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new AiError("bad-response", "ChatGPT returned too much data.");
      yield next.value;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function boundedJson(response: Response, signal: AbortSignal, limit = 512 * 1024): Promise<Record<string, unknown>> {
  if (!response.body) throw new AiError("bad-response", "ChatGPT returned no data.");
  const parts: Uint8Array[] = [];
  for await (const part of boundedChunks(response.body, signal, limit)) parts.push(part);
  try {
    return object(JSON.parse(Buffer.concat(parts).toString("utf8")));
  } catch {
    throw new AiError("bad-response", "ChatGPT returned invalid data.");
  }
}

export function request(fetchFn: FetchLike, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  // Redirects must never forward credentials to a different origin.
  return fetchFn(url, { ...init, signal, redirect: "error" });
}

export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function connectionError(signal: AbortSignal, error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (signal.aborted) {
    return signal.reason?.name === "TimeoutError"
      ? new AiError("unreachable", "ChatGPT timed out. Try again.")
      : new AiError("cancelled", "Cancelled.");
  }
  return new AiError("unreachable", "Could not reach ChatGPT. Try again.");
}

/**
 * Text that came from OpenAI goes into messages the app shows, so it is reduced to what a diagnostic needs. Error
 * codes are short snake_case words; anything long enough to be a token (an echoed bearer, a JWT, a refresh token) is
 * removed from free text such as an admission "detail".
 */
export function diagnosticCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_.]{0,79}$/.test(value) ? value : "";
}
export function diagnosticText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/bearer\s+\S+/gi, "Bearer [redacted]").replace(/[A-Za-z0-9._~+/=-]{24,}/g, "[redacted]").slice(0, 120);
}
export function requestIdOf(response: Response): string | null {
  const id = response.headers.get("x-request-id");
  return id && /^[A-Za-z0-9_.:-]{1,100}$/.test(id) ? id : null;
}
