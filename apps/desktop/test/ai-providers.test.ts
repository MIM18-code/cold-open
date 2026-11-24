import assert from "node:assert/strict";
import { test } from "node:test";

import { AiError, MAX_ANSWER, type ChatRequest, buildRequest, listModels, pickOllamaModel, readDelta, streamChat } from "../src/main/ai/providers.ts";
import { MAX_LINE, MAX_STREAM_BYTES, readLines, readSse } from "../src/main/ai/stream.ts";

const request: ChatRequest = {
  model: "m1", tier: "fast", system: "Be brief.", maxTokens: 500, json: false,
  messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }, { role: "user", content: "Again" }],
};

/** A response whose body arrives in the given pieces, so tests cover events split across chunks. */
function streamOf(pieces: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  }), init);
}

const noSignal = new AbortController().signal;

test("Ollama request: local endpoint, streaming, no thinking, a window big enough for a script", () => {
  const built = buildRequest("ollama", request, { ollamaEndpoint: "http://127.0.0.1:11434/" });
  assert.equal(built.url, "http://127.0.0.1:11434/api/chat");
  const body = JSON.parse(built.init.body!);
  assert.equal(body.stream, true);
  assert.equal(body.think, false);
  assert.equal(body.options.num_ctx, 16384);
  assert.deepEqual(body.messages[0], { role: "system", content: "Be brief." });
  assert.equal(body.messages.length, 4);
  assert.equal(body.format, undefined);
  assert.equal(JSON.parse(buildRequest("ollama", { ...request, json: true }, { ollamaEndpoint: "http://x" }).init.body!).format, "json");
});

test("Anthropic request: key header, version, system and messages", () => {
  const built = buildRequest("anthropic", request, { ollamaEndpoint: "", apiKey: "sk-ant-test" });
  assert.equal(built.url, "https://api.anthropic.com/v1/messages");
  assert.equal(built.init.headers["x-api-key"], "sk-ant-test");
  assert.equal(built.init.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(built.init.body!);
  assert.equal(body.system, "Be brief.");
  assert.equal(body.max_tokens, 500);
  assert.equal(body.stream, true);
  assert.equal(body.messages.length, 3);
});

test("Gemini request: key in a header, roles mapped, explicit thinking level, JSON mode", () => {
  const built = buildRequest("google", { ...request, model: "gemini-3.8-flash", json: true }, { ollamaEndpoint: "", apiKey: "g-key" });
  assert.equal(built.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse");
  assert.equal(built.init.headers["x-goog-api-key"], "g-key");
  assert.ok(!built.url.includes("g-key"));
  const body = JSON.parse(built.init.body!);
  assert.deepEqual(body.contents.map((c: { role: string }) => c.role), ["user", "model", "user"]);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.systemInstruction.parts[0].text, "Be brief.");
});

test("OpenAI request: Responses API, bearer key, nothing stored", () => {
  const built = buildRequest("openai", request, { ollamaEndpoint: "", apiKey: "sk-test" });
  assert.equal(built.url, "https://api.openai.com/v1/responses");
  assert.equal(built.init.headers.authorization, "Bearer sk-test");
  const body = JSON.parse(built.init.body!);
  assert.equal(body.instructions, "Be brief.");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.max_output_tokens, 500);
});

test("response parsing for each provider", () => {
  assert.deepEqual(readDelta("ollama", JSON.stringify({ message: { content: "Hi" }, done: false })), { text: "Hi" });
  assert.deepEqual(readDelta("ollama", JSON.stringify({ message: { content: "" }, done: true })), { done: true });
  assert.equal(readDelta("ollama", JSON.stringify({ error: "model not found" })).error?.message, "model not found");
  assert.deepEqual(readDelta("anthropic", { data: JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "A" } }) }), { text: "A" });
  assert.deepEqual(readDelta("anthropic", { data: JSON.stringify({ type: "message_stop" }) }), { done: true });
  assert.deepEqual(readDelta("anthropic", { data: JSON.stringify({ type: "ping" }) }), {});
  assert.equal(readDelta("anthropic", { data: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) }).error?.code, "rate-limited");
  assert.deepEqual(readDelta("google", { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: "plan", thought: true }, { text: "G" }] } }] }) }), { text: "G" });
  assert.deepEqual(readDelta("google", { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "STOP" }] }) }), { text: "!", done: true });
  assert.equal(readDelta("google", { data: JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }) }).error?.code, "failed");
  assert.deepEqual(readDelta("openai", { data: JSON.stringify({ type: "response.output_text.delta", delta: "O" }) }), { text: "O" });
  assert.deepEqual(readDelta("openai", { data: JSON.stringify({ type: "response.completed" }) }), { done: true });
  assert.equal(readDelta("openai", { data: JSON.stringify({ type: "response.failed", response: { error: { message: "You hit the usage limit." } } }) }).error?.code, "rate-limited");
  assert.deepEqual(readDelta("openai", "not json"), {});
  // As the live API sends it when the account has no credits: the details sit under "error".
  const broke = readDelta("openai", { data: JSON.stringify({ type: "error", error: {
    type: "insufficient_quota", code: "credit_balance_exhausted", message: "You have no credits remaining.", param: null } }) });
  assert.deepEqual(broke, { error: { code: "rate-limited", message: "You have no credits remaining." } });
});

test("SSE and line readers handle events split across chunks", async () => {
  const body = streamOf(["event: a\nda", "ta: one\n\ndata: tw", "o\ndata: more\n\n", "data: last"]);
  const events: unknown[] = [];
  for await (const event of readSse(body.body!)) events.push(event);
  assert.deepEqual(events, [{ event: "a", data: "one" }, { data: "two\nmore" }, { data: "last" }]);
  const lines: string[] = [];
  for await (const line of readLines(streamOf(['{"a":1}\r\n{"b"', ":2}\n\n", "tail"]).body!)) lines.push(line);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', "tail"]);
});

test("a body that goes quiet ends with a plain message, and a reader that stops cancels the body", async () => {
  const quiet = () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode('{"a":1}\n')),
      cancel: () => { cancelled = true; },
    });
    return { body, cancelled: () => cancelled };
  };
  const hung = new Promise<string>((resolve) => setTimeout(() => resolve("still reading"), 2000).unref());
  const stalled = quiet();
  const lines: string[] = [];
  const outcome = await Promise.race([hung, (async () => {
    for await (const line of readLines(stalled.body, 50)) lines.push(line);
    return "finished";
  })().catch((error: Error) => error.message)]);
  assert.deepEqual(lines, ['{"a":1}']);
  assert.match(outcome, /sent nothing for 1 minutes/);
  assert.equal(stalled.cancelled(), true);
  // A caller that stops after the first event (an error in the answer, or Cancel) closes the connection too.
  const stopped = quiet();
  for await (const line of readLines(stopped.body)) { assert.equal(line, '{"a":1}'); break; }
  assert.equal(stopped.cancelled(), true);
});

test("a body whose cancel never settles still lets the stall reach the caller", async () => {
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(new TextEncoder().encode("line\n")),
    cancel: () => new Promise<void>(() => undefined),
  });
  const hung = new Promise<string>((resolve) => setTimeout(() => resolve("still reading"), 2000).unref());
  const outcome = await Promise.race([hung, (async () => {
    for await (const _line of readLines(body, 50)) { /* read until it stalls */ }
    return "finished";
  })().catch((error: Error) => error.message)]);
  assert.match(outcome, /sent nothing/);
});

test("streamChat joins Ollama lines and reports each piece", async () => {
  const seen: string[] = [];
  const text = await streamChat("ollama", request, { ollamaEndpoint: "http://x" }, async (url, init) => {
    assert.equal(url, "http://x/api/chat");
    assert.equal(init.method, "POST");
    return streamOf([JSON.stringify({ message: { content: "Hel" } }) + "\n", JSON.stringify({ message: { content: "lo" } }) + "\n" + JSON.stringify({ done: true }) + "\n"]);
  }, noSignal, (piece) => seen.push(piece));
  assert.equal(text, "Hello");
  assert.deepEqual(seen, ["Hel", "lo"]);
});

test("streamChat returns on the terminal event even if the provider leaves the connection open, and closes it", async () => {
  let cancelled = false;
  const open = () => new Response(new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(new TextEncoder().encode(
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Done." } })}\n\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`)),
    cancel: () => { cancelled = true; },
  }));
  const hung = new Promise<string>((resolve) => setTimeout(() => resolve("still reading"), 2000).unref());
  const text = await Promise.race([hung, streamChat("anthropic", request, { ollamaEndpoint: "", apiKey: "k" }, async () => open(), noSignal, () => undefined)]);
  assert.equal(text, "Done.");
  assert.equal(cancelled, true);
});

test("streamChat reads Anthropic events", async () => {
  const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  const text = await streamChat("anthropic", request, { ollamaEndpoint: "", apiKey: "k" }, async () => streamOf([
    sse({ type: "message_start" }), sse({ type: "content_block_delta", delta: { type: "text_delta", text: "Scene " } }),
    sse({ type: "content_block_delta", delta: { type: "text_delta", text: "4." } }), sse({ type: "message_stop" }),
  ]), noSignal, () => undefined);
  assert.equal(text, "Scene 4.");
});

test("HTTP failures become plain errors with a code", async () => {
  const fail = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  await assert.rejects(streamChat("anthropic", request, { ollamaEndpoint: "", apiKey: "bad" }, fail(401, { error: { message: "invalid x-api-key" } }), noSignal, () => undefined),
    (error: AiError) => error.code === "unauthorized" && /did not accept the API key/.test(error.message));
  await assert.rejects(streamChat("openai", request, { ollamaEndpoint: "", apiKey: "k" }, fail(429, { error: { message: "Too many" } }), noSignal, () => undefined),
    (error: AiError) => error.code === "rate-limited");
  await assert.rejects(streamChat("ollama", request, { ollamaEndpoint: "http://x" }, async () => { throw new TypeError("fetch failed"); }, noSignal, () => undefined),
    (error: AiError) => error.code === "unreachable" && /Ollama is not running/.test(error.message));
});

test("an error in the middle of a stream is reported, an empty stream is an error", async () => {
  await assert.rejects(streamChat("ollama", request, { ollamaEndpoint: "http://x" }, async () => streamOf([JSON.stringify({ message: { content: "Hi" } }) + "\n", JSON.stringify({ error: "out of memory" }) + "\n"]),
    noSignal, () => undefined), /out of memory/);
  await assert.rejects(streamChat("ollama", request, { ollamaEndpoint: "http://x" }, async () => streamOf([]), noSignal, () => undefined),
    (error: AiError) => error.code === "bad-response");
});

test("cancelling stops a stream", async () => {
  const controller = new AbortController();
  const slow = async (_url: string, init: RequestInit) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: "Hi" } }) + "\n"));
      init.signal!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
    },
  }));
  await assert.rejects(streamChat("ollama", request, { ollamaEndpoint: "http://x" }, slow, controller.signal, () => controller.abort()),
    (error: AiError) => error.code === "cancelled");
});

test("model lists", async () => {
  const json = (body: unknown) => async () => new Response(JSON.stringify(body));
  assert.deepEqual(await listModels("ollama", { ollamaEndpoint: "http://x" }, json({ models: [{ name: "qwen3.5:4b", size: 3.3e9 }] }), noSignal), [{ id: "qwen3.5:4b", size: 3.3e9 }]);
  assert.deepEqual(await listModels("anthropic", { ollamaEndpoint: "", apiKey: "k" }, json({ data: [{ id: "claude-haiku-5-5" }] }), noSignal), [{ id: "claude-haiku-5-5" }]);
  assert.deepEqual(await listModels("google", { ollamaEndpoint: "", apiKey: "k" }, json({ models: [
    { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }] }), noSignal), [{ id: "gemini-3.8-flash" }]);
  assert.deepEqual((await listModels("openai", { ollamaEndpoint: "", apiKey: "k" }, json({ data: [{ id: "gpt-6-luna" }, { id: "whisper-1" }] }), noSignal)).map((m) => m.id), ["gpt-6-luna"]);
});

test("the best small Ollama model", () => {
  assert.equal(pickOllamaModel([{ name: "gemma4:e4b", size: 9.6e9 }, { name: "qwen3.5:4b", size: 3.3e9 }, { name: "llama3.2:3b", size: 2e9 }]), "qwen3.5:4b");
  assert.equal(pickOllamaModel([{ name: "gemma4:e4b", size: 9.6e9 }, { name: "nomic-embed-text", size: 3e8 }]), "gemma4:e4b");
  assert.equal(pickOllamaModel([{ name: "big:70b", size: 40e9 }, { name: "odd:7b", size: 4e9 }]), "odd:7b");
  assert.equal(pickOllamaModel([{ name: "big:70b", size: 40e9 }]), "big:70b");
  assert.equal(pickOllamaModel([]), null);
});

test("a body that never ends a line, or an answer that never ends, is stopped", async () => {
  const filler = "x".repeat(1024 * 1024);
  const endless = () => streamOf(Array.from({ length: MAX_LINE / filler.length + 2 }, () => filler));
  await assert.rejects(async () => { for await (const _ of readLines(endless().body!)); }, /too long/);
  await assert.rejects(async () => { for await (const _ of readSse(streamOf(["data: ", ...Array.from({ length: MAX_LINE / filler.length + 2 }, () => filler)]).body!)); }, /too long/);
  // Many data lines for one event add up the same way.
  const lines = Array.from({ length: MAX_LINE / filler.length + 2 }, () => `data: ${filler}\n`);
  await assert.rejects(async () => { for await (const _ of readSse(streamOf(lines).body!)); }, /too long/);
  // So do empty data lines, which carry no characters of their own.
  const empty = "data:\n".repeat(100_000);
  await assert.rejects(async () => { for await (const _ of readSse(streamOf(Array.from({ length: MAX_LINE / 100_000 + 2 }, () => empty)).body!)); }, /too long/);
  // A line that arrives whole, with its line break, is measured too.
  const whole = "z".repeat(MAX_LINE + 1) + "\n";
  await assert.rejects(async () => { for await (const _ of readLines(streamOf([whole]).body!)); }, /too long/);
  await assert.rejects(async () => { for await (const _ of readSse(streamOf([`data: ${whole}\n`]).body!)); }, /too long/);
  // A long but ordinary line is still read.
  const read: string[] = [];
  for await (const line of readLines(streamOf([filler, "\n"]).body!)) read.push(line);
  assert.equal(read[0]!.length, filler.length);

  const piece = JSON.stringify({ message: { content: "y".repeat(500_000) }, done: false }) + "\n";
  const flood = () => streamOf(Array.from({ length: MAX_ANSWER / 500_000 + 2 }, () => piece));
  const noSignal = new AbortController().signal;
  await assert.rejects(streamChat("ollama", { model: "m", messages: [{ role: "user", content: "hi" }] } as ChatRequest, { ollamaEndpoint: "http://x" }, async () => flood(), noSignal, () => undefined),
    (error: unknown) => error instanceof AiError && /more than one answer can hold/.test(error.message));

  // Endless non-text events (empty Ollama deltas or Gemini thought parts) stop once the stream exceeds MAX_STREAM_BYTES.
  const emptyDelta = '{"message":{"content":""},"done":false}\n'.repeat(25_000);
  const emptyCount = Math.ceil(MAX_STREAM_BYTES / emptyDelta.length) + 1;
  await assert.rejects(
    streamChat("ollama", { model: "m", messages: [{ role: "user", content: "hi" }] } as ChatRequest, { ollamaEndpoint: "http://x" },
      async () => streamOf(Array.from({ length: emptyCount }, () => emptyDelta)), noSignal, () => undefined),
    // "bad-response", not "unreachable": for the local model the second opens AI setup and hides this message.
    (error: unknown) => error instanceof AiError && error.code === "bad-response" && /more data than one answer can hold/.test(error.message),
  );

  const thought = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: "x".repeat(64_000) }] } }] })}\n\n`;
  const thoughtCount = Math.ceil(MAX_STREAM_BYTES / thought.length) + 1;
  await assert.rejects(
    streamChat("google", { model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] } as ChatRequest, { ollamaEndpoint: "http://x", apiKey: "k" },
      async () => streamOf(Array.from({ length: thoughtCount }, () => thought)), noSignal, () => undefined),
    (error: unknown) => error instanceof AiError && /more data than one answer can hold/.test(error.message),
  );
});
