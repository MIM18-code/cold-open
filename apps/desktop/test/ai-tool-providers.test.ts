import assert from "node:assert/strict";
import { test } from "node:test";
import { AiError, toolChat, type ChatRequest, type HttpProvider } from "../src/main/ai/providers.ts";
import { readResponseTurn, validateCalls, validateMessages, validateTools } from "../src/main/ai/tool-calls.ts";
import { MAX_TOOL_ARGUMENT_CHARS, MAX_TOOL_CALLS, type AiMessage, type AiTool, type AiToolCall } from "../src/shared/channels/ai.ts";

const tools: AiTool[] = [{ name: "read_scene", description: "Read a scene", parameters: { type: "object", properties: { scene: { type: "string" } }, required: ["scene"], additionalProperties: false } }];
const call: AiToolCall = { id: "c1", name: "read_scene", arguments: { scene: "12" } };
const messages: AiMessage[] = [{ role: "user", content: "Read Scene 12" }, { role: "assistant", content: "", toolCalls: [call] },
  { role: "tool", toolCallId: "c1", name: "read_scene", content: '{"text":"Scene text"}' }];
const chat: ChatRequest = { model: "test", tier: "smart", system: "Look first", messages, tools, json: false, maxTokens: 2000 };
const config = { apiKey: "test-key", ollamaEndpoint: "http://local/" };
const signal = new AbortController().signal;
const response = (provider: HttpProvider, name: unknown = "read_scene", args: unknown = { scene: "12A" }): unknown => {
  switch (provider) {
    case "ollama": return { done: true, message: { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] } };
    case "anthropic": return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "c2", name, input: args }] };
    case "google": return { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { id: "c2", name, args }, thoughtSignature: "signed" }] } }] };
    case "openai": return { status: "completed", output: [{ type: "function_call", call_id: "c2", name, arguments: typeof args === "string" ? args : JSON.stringify(args) }] };
  }
};

for (const provider of ["ollama", "anthropic", "google", "openai"] as const) {
  test(`${provider} maps function declarations, assistant calls and tool results through fetch`, async () => {
    const turn = await toolChat(provider, chat, config, async (url, init) => {
      const body = JSON.parse(String(init.body));
      assert.equal(init.method, "POST");
      if (provider !== "google") assert.equal(body.stream, false);
      switch (provider) {
        case "ollama":
          assert.equal(url, "http://local/api/chat");
          assert.deepEqual(body.tools, [{ type: "function", function: tools[0] }]);
          assert.equal(body.messages[0].role, "system");
          assert.equal(body.messages[2].tool_calls[0].function.name, "read_scene");
          assert.deepEqual(body.messages[2].tool_calls[0].function.arguments, call.arguments);
          assert.deepEqual(body.messages[3], { role: "tool", tool_name: "read_scene", content: messages[2]!.content });
          break;
        case "anthropic":
          assert.equal(url, "https://api.anthropic.com/v1/messages");
          assert.deepEqual(body.tools, [{ name: tools[0]!.name, description: tools[0]!.description, input_schema: tools[0]!.parameters }]);
          assert.deepEqual(body.messages[1].content, [{ type: "tool_use", id: "c1", name: "read_scene", input: call.arguments }]);
          assert.deepEqual(body.messages[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: messages[2]!.content }] });
          break;
        case "google":
          assert.ok(url.endsWith(":generateContent"));
          assert.equal(body.tools[0].functionDeclarations[0].name, "read_scene");
          assert.deepEqual(body.tools[0].functionDeclarations[0].parametersJsonSchema, tools[0]!.parameters);
          assert.equal(body.contents[1].role, "model");
          assert.deepEqual(body.contents[1].parts[0].functionCall, { id: "c1", name: "read_scene", args: call.arguments });
          assert.deepEqual(body.contents[2].parts, [{ functionResponse: { id: "c1", name: "read_scene", response: { result: messages[2]!.content } } }]);
          break;
        case "openai":
          assert.equal(url, "https://api.openai.com/v1/responses");
          assert.equal(body.store, false);
          assert.equal(body.previous_response_id, undefined);
          assert.deepEqual(body.tools, [{ type: "function", ...tools[0], strict: false }]);
          assert.deepEqual(body.input[1], { type: "function_call", call_id: "c1", name: "read_scene", arguments: JSON.stringify(call.arguments) });
          assert.deepEqual(body.input[2], { type: "function_call_output", call_id: "c1", output: messages[2]!.content });
          break;
      }
      return new Response(JSON.stringify(response(provider)));
    }, signal);
    assert.equal(turn.text, "");
    assert.equal(turn.toolCalls!.length, 1);
    assert.equal(turn.toolCalls![0]!.name, "read_scene");
    assert.deepEqual(turn.toolCalls![0]!.arguments, { scene: "12A" });
    assert.ok(turn.toolCalls![0]!.id);
    if (provider === "google") assert.equal(turn.toolCalls![0]!.signature, "signed");
  });

  test(`${provider} returns final text when there are no tool calls`, async () => {
    const raw = provider === "ollama" ? { done: true, message: { content: "Answer." } }
      : provider === "anthropic" ? { stop_reason: "end_turn", content: [{ type: "text", text: "Answer." }] }
      : provider === "google" ? { candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "Private reasoning" }, { text: "Answer." }] } }] }
      : { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Answer." }] }] };
    assert.deepEqual(await toolChat(provider, chat, config, async () => new Response(JSON.stringify(raw)), signal), { text: "Answer." });
  });

  test(`${provider} rejects unknown names and invalid or oversized argument JSON`, async () => {
    const invalid = [response(provider, "read_file"), response(provider, "read_scene", "{bad"), response(provider, "read_scene", []),
      response(provider, "read_scene", { scene: "x".repeat(MAX_TOOL_ARGUMENT_CHARS) })];
    for (const raw of invalid) await assert.rejects(toolChat(provider, chat, config, async () => new Response(JSON.stringify(raw)), signal),
      (error: AiError) => error.code === "tool-parse");
  });
}

test("tool batches reject more than eight calls and duplicate IDs before execution", () => {
  assert.throws(() => validateCalls(Array.from({ length: MAX_TOOL_CALLS + 1 }, (_, index) => ({ ...call, id: String(index) })), tools), /invalid tool call/);
  assert.throws(() => validateCalls([call, call], tools), /invalid tool call/);
  assert.throws(() => validateCalls([{ ...call, name: "read scene" }], tools), /invalid tool call/);
  assert.throws(() => validateCalls([{ ...call, arguments: "null" }], tools), /invalid tool call/);
  assert.equal(validateCalls(Array.from({ length: 8 }, (_, index) => ({ ...call, id: String(index) })), tools).length, 8);
});

test("main validates tool declarations and preserves matching tool history", () => {
  assert.deepEqual(validateTools(tools), tools);
  assert.deepEqual(validateMessages(messages, tools), messages);
  assert.throws(() => validateTools([...tools, ...tools]), /Invalid tool/);
  assert.throws(() => validateTools([{ ...tools[0]!, name: "read file" }]), /Invalid tool/);
  assert.throws(() => validateMessages(messages.slice(0, 2), tools), /need results/);
  assert.throws(() => validateMessages([messages[0]!, { ...messages[2]!, toolCallId: "unknown" }], tools), /matching call/);
  assert.throws(() => validateMessages(messages), /Invalid tool history/);
});

test("Anthropic and Google group parallel results into a single user message", async () => {
  const second = { ...call, id: "c2" };
  const history: AiMessage[] = [messages[0]!, { role: "assistant", content: "", toolCalls: [call, second] }, messages[2]!,
    { ...messages[2]!, toolCallId: "c2", content: "second" }];
  for (const provider of ["anthropic", "google"] as const) await toolChat(provider, { ...chat, messages: history }, config, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const output = provider === "anthropic" ? body.messages : body.contents;
    assert.equal(output.length, 3);
    assert.equal((output[2].content ?? output[2].parts).length, 2);
    return new Response(JSON.stringify(response(provider)));
  }, signal);
});

test("Google sends each function call's thought signature back intact", async () => {
  await toolChat("google", { ...chat, messages: [messages[0]!, { ...messages[1]!, toolCalls: [{ ...call, signature: "opaque-signature" }] }, messages[2]!] }, config,
    async (_url, init) => {
      assert.equal(JSON.parse(String(init.body)).contents[1].parts[0].thoughtSignature, "opaque-signature");
      return new Response(JSON.stringify(response("google")));
    }, signal);
});

test("Google accepts a no-argument call without a provider ID and preserves it on replay", async () => {
  const declaration = { name: "list_scenes", description: "List scenes", parameters: { type: "object", properties: {} } };
  const turn = await toolChat("google", { ...chat, tools: [declaration] }, config, async () => new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "list_scenes" }, thoughtSignature: "signed" }] } }],
  })), signal);
  const call = turn.toolCalls![0]!;
  assert.ok(call.id);
  assert.deepEqual(call.arguments, {});
  await toolChat("google", { ...chat, tools: [declaration], messages: [messages[0]!, { role: "assistant", content: "", toolCalls: [call] },
    { role: "tool", name: "list_scenes", toolCallId: call.id, content: "[]" }] }, config, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.contents[1].parts[0].functionCall.id, undefined);
    assert.equal(body.contents[1].parts[0].thoughtSignature, "signed");
    assert.equal(body.contents[2].parts[0].functionResponse.id, undefined);
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Done" }] } }] }));
  }, signal);
});

test("Responses preserves encrypted reasoning with manual history and never guesses partial calls", async () => {
  const raw = { status: "completed", output: [{ type: "reasoning", id: "rs_1", encrypted_content: "encrypted", summary: [{ type: "summary_text", text: "Look first" }] },
    { type: "function_call", call_id: "c1", name: "read_scene", arguments: '{"scene":"12"}' }] };
  const turn = readResponseTurn(raw, tools);
  assert.equal(turn.reasoning![0]!.encryptedContent, "encrypted");
  await toolChat("openai", { ...chat, messages: [messages[0]!, { ...messages[1]!, reasoning: turn.reasoning }, messages[2]!] }, config, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(body.input[1], raw.output[0]);
    return new Response(JSON.stringify(response("openai")));
  }, signal);
  assert.throws(() => readResponseTurn({ ...raw, status: "incomplete" }, tools), /did not complete/);
});

test("tool turns reject malformed response JSON and stop a stalled response on cancellation", async () => {
  await assert.rejects(toolChat("ollama", chat, config, async () => new Response("{bad"), signal), (error: AiError) => error.code === "tool-parse");
  const controller = new AbortController();
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const pending = toolChat("ollama", chat, config, async () => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode('{"message":'));
    entered();
  } })), controller.signal);
  await waiting; controller.abort();
  await assert.rejects(pending, (error: AiError) => error.code === "cancelled");
});

test("Ollama models without tools report a recoverable tool failure", async () => {
  await assert.rejects(toolChat("ollama", chat, config, async () => new Response(JSON.stringify({ error: "This model does not support tools" }), { status: 400 }), signal),
    (error: AiError) => error.code === "tool-parse");
});
