import assert from "node:assert/strict";
import { test } from "node:test";

import { AiError, type ChatRequest, buildRequest, listModels, pickOllamaModel, readDelta, streamChat } from "../src/main/ai/providers.ts";
import { readLines, readSse } from "../src/main/ai/stream.ts";

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
