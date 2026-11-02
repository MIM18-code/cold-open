// Reading streamed HTTP bodies: newline-delimited JSON (Ollama) and server-sent events (the cloud APIs).

async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  } finally {
    reader.releaseLock();
  }
}

/** Each non-empty line of a body, as it arrives. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of chunks(body)) {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim()) yield line;
    }
  }
  if (buffer.trim()) yield buffer.replace(/\r$/, "");
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Server-sent events: blocks of `event:` and `data:` lines separated by a blank line. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];
  const flush = (): SseEvent | null => {
    const out = data.length ? { ...(event ? { event } : {}), data: data.join("\n") } : null;
    event = undefined;
    data = [];
    return out;
  };
  let buffer = "";
  for await (const chunk of chunks(body)) {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line === "") {
        const out = flush();
        if (out) yield out;
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
  const out = flush();
  if (out) yield out;
}
