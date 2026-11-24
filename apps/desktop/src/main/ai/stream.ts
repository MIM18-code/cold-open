// Reading streamed HTTP bodies: newline-delimited JSON (Ollama) and server-sent events (the cloud APIs).

/** How long a body may send nothing before the answer is given up on. Long enough for a model to load or think. */
const STALL_MS = 3 * 60_000;

/**
 * The longest single line, or one event's data, that is read. A server that streams without ever ending a line
 * would otherwise fill memory. Real lines are a few kilobytes.
 */
export const MAX_LINE = 4 * 1024 * 1024;
/**
 * Total bytes accepted from one streamed response. Stops endpoints or runaway thinking loops that emit endless
 * small events carrying no visible answer text, which would never trip MAX_LINE or MAX_ANSWER.
 */
export const MAX_STREAM_BYTES = 32 * 1024 * 1024;
/**
 * The body went past a limit above. The server answered, so this is a bad answer and not a lost connection: for the
 * local model, a lost connection sends the writer to AI setup and hides the reason.
 */
export class StreamLimitError extends Error {}
const tooLong = () => new StreamLimitError("it sent a line too long to read");
const tooMuch = () => new StreamLimitError("it sent more data than one answer can hold");

async function* chunks(body: ReadableStream<Uint8Array>, stallMs: number): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let received = 0;
  const stalled = () => new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`it sent nothing for ${Math.round(stallMs / 60_000) || 1} minutes`)), stallMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stalled()]).finally(() => clearTimeout(timer));
      if (done) break;
      received += value.byteLength;
      if (received > MAX_STREAM_BYTES) throw tooMuch();
      yield decoder.decode(value, { stream: true });
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  } finally {
    // Cancel, not just release: a reader that stops early (a stall, an error, a cancelled answer) closes the connection.
    // Not awaited: a body whose cancel never settles must not hold back the error or the answer.
    reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Each non-empty line of a body, as it arrives. */
export async function* readLines(body: ReadableStream<Uint8Array>, stallMs = STALL_MS): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of chunks(body, stallMs)) {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      // A whole line can arrive in one piece, so the finished line is checked as well as the unfinished rest.
      if (line.length > MAX_LINE) throw tooLong();
      if (line.trim()) yield line;
    }
    if (buffer.length > MAX_LINE) throw tooLong();
  }
  if (buffer.trim()) yield buffer.replace(/\r$/, "");
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Server-sent events: blocks of `event:` and `data:` lines separated by a blank line. */
export async function* readSse(body: ReadableStream<Uint8Array>, stallMs = STALL_MS): AsyncGenerator<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];
  let held = 0;
  const flush = (): SseEvent | null => {
    const out = data.length ? { ...(event ? { event } : {}), data: data.join("\n") } : null;
    event = undefined;
    data = [];
    held = 0;
    return out;
  };
  const keep = (line: string) => {
    // One more for the line itself, so a run of empty data lines counts too.
    held += line.length + 1;
    if (held > MAX_LINE) throw tooLong();
    data.push(line);
  };
  let buffer = "";
  for await (const chunk of chunks(body, stallMs)) {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      // A whole line can arrive in one piece, so the finished line is checked as well as the unfinished rest.
      if (line.length > MAX_LINE) throw tooLong();
      if (line === "") {
        const out = flush();
        if (out) yield out;
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) keep(line.slice(5).replace(/^ /, ""));
    }
    if (buffer.length > MAX_LINE) throw tooLong();
  }
  if (buffer.startsWith("data:")) keep(buffer.slice(5).replace(/^ /, ""));
  const out = flush();
  if (out) yield out;
}
