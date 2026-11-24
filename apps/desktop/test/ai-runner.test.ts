import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CHANNELS } from "../src/shared/api.ts";
import { AI_SETTINGS, type AiEvent, type AiRequest } from "../src/shared/channels/ai.ts";
import type { Handler, ServiceContext } from "../src/main/context.ts";
import { summarizeBacklot } from "../src/main/ai/backlot.ts";
import { type Cipher, KeyStore } from "../src/main/ai/keys.ts";
import type { AiError } from "../src/main/ai/providers.ts";
import { AiRunner } from "../src/main/ai/runner.ts";
import { register as registerSettings } from "../src/main/services/settings.ts";

const cipher: Cipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(text.split("").reverse().join("")),
  decrypt: (data) => data.toString().split("").reverse().join(""),
};
const folder = () => mkdtempSync(join(tmpdir(), "ai-test-"));

function ndjson(...contents: string[]): Response {
  const lines = contents.map((content) => JSON.stringify({ message: { content } }) + "\n").join("") + JSON.stringify({ done: true }) + "\n";
  return new Response(lines);
}

function runnerWith(settings: Record<string, unknown>, fetchFn: (url: string, init: RequestInit) => Promise<Response>, keys = new KeyStore(join(folder(), "keys.json"), cipher)) {
  return { keys, runner: new AiRunner({ setting: (key) => settings[key] as never, keys, fetch: fetchFn }) };
}

const ANTHROPIC_OK = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } })}\n\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
const OPENAI_OK = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`;

const request = (extra: Partial<AiRequest> = {}): AiRequest => ({ id: "r1", tier: "smart", system: "SYSTEM", messages: [{ role: "user", content: "hello" }], ...extra });

function collect(): { events: AiEvent[]; emit: (e: AiEvent) => void; finished: Promise<AiEvent> } {
  const events: AiEvent[] = [];
  let resolve!: (e: AiEvent) => void;
  const finished = new Promise<AiEvent>((r) => (resolve = r));
  return { events, finished, emit: (e) => { events.push(e); if (e.type !== "delta") resolve(e); } };
}

test("keys are stored encrypted and read back only inside the main process", () => {
  const file = join(folder(), "keys.json");
  const keys = new KeyStore(file, cipher);
  assert.equal(keys.has("anthropic"), false);
  keys.set("anthropic", "  sk-ant-secret-123 ");
  assert.equal(keys.has("anthropic"), true);
  assert.equal(keys.get("anthropic"), "sk-ant-secret-123");
  assert.ok(!readFileSync(file, "utf8").includes("sk-ant-secret"), "the key is not on disk in the clear");
  assert.throws(() => keys.set("google", "has space"), /no spaces/);
  assert.throws(() => keys.set("google", " "), /Paste the key/);
  keys.clear("anthropic");
  assert.equal(keys.has("anthropic"), false);
  assert.throws(() => new KeyStore(file, { ...cipher, available: () => false }).set("openai", "k"), /can't encrypt/);
});

test("status shows only whether a key is set", async () => {
  const { runner } = runnerWith({}, async () => new Response("{}"));
  runner.setKey("anthropic", "sk-ant-secret-456");
  const status = await runner.status();
  assert.equal(status.providers.find((p) => p.provider === "anthropic")?.keySet, true);
  assert.equal(status.providers.find((p) => p.provider === "google")?.keySet, false);
  assert.ok(!JSON.stringify(status).includes("secret"));
  assert.equal(status.active.provider, "ollama");
  assert.throws(() => runner.setKey("ollama", "x"), /does not use a key/);
});

test("runner returns validated tool calls and preserves tool result history through IPC", async () => {
  const tools = [{ name: "read_scene", description: "Read scene", parameters: { type: "object", properties: { scene: { type: "string" } } } }];
  const { runner } = runnerWith({ "ai.model.ollama": "m" }, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.stream, false);
    if (body.messages.length > 2) {
      assert.equal(body.messages[2].tool_calls[0].function.name, "read_scene");
      assert.deepEqual(body.messages[3], { role: "tool", tool_name: "read_scene", content: "Scene text" });
      return new Response(JSON.stringify({ done: true, message: { content: "Answer." } }));
    }
    return new Response(JSON.stringify({ done: true, message: { content: "", tool_calls: [{ function: { name: "read_scene", arguments: { scene: "12" } } }] } }));
  });
  const first = collect();
  await runner.start("w", request({ tools }), first.emit);
  const event = await first.finished;
  assert.equal(event.type, "done");
  assert.ok(event.type === "done" && event.toolCalls?.length);
  if (event.type !== "done") return;
  assert.equal(first.events.length, 1, "no text deltas for tool turns");
  const second = collect();
  await runner.start("w", request({ id: "r2", tools, messages: [{ role: "user", content: "Read scene" },
    { role: "assistant", content: "", toolCalls: event.toolCalls },
    { role: "tool", name: "read_scene", toolCallId: event.toolCalls![0]!.id, content: "Scene text" }] }), second.emit);
  assert.deepEqual(await second.finished, { id: "r2", type: "done", text: "Answer." });
});

test("runner emits tool-parse errors for malformed calls without exposing partial batches", async () => {
  const { runner } = runnerWith({ "ai.model.ollama": "m" }, async () => new Response(JSON.stringify({ done: true, message: { tool_calls: [
    { function: { name: "list_scenes", arguments: {} } }, { function: { name: "read_file", arguments: {} } },
  ] } })));
  const sink = collect();
  await runner.start("w", request({ tools: [{ name: "list_scenes", description: "List scenes", parameters: { type: "object", properties: {} } }] }), sink.emit);
  const event = await sink.finished;
  assert.ok(event.type === "error" && event.code === "tool-parse");
  assert.equal(sink.events.length, 1);
});

test("production-data IPC returns only the existing summary, never the project path", async () => {
  const path = join(folder(), "project.json");
  writeFileSync(path, JSON.stringify({ meta: { title: "Project" }, script: { scenes: [{ number: "12", heading: "INT. ROOM - DAY" }] } }));
  const settings: Record<string, unknown> = { [AI_SETTINGS.backlotPath]: path };
  const { runner } = runnerWith(settings, async () => new Response("{}"));
  const result = await runner.productionData();
  assert.ok(result.ok);
  assert.match(JSON.stringify(result), /INT\. ROOM - DAY/);
  assert.ok(!JSON.stringify(result).includes(path));
  settings[AI_SETTINGS.backlotPath] = "/private/missing.json";
  assert.deepEqual(await runner.productionData(), { ok: false, error: "The Backlot project could not be read." });
  delete settings[AI_SETTINGS.backlotPath];
  assert.deepEqual(await runner.productionData(), { ok: false, error: "No Backlot project is set." });
});

test("Ollama: picks the best installed model, streams events and finishes", async () => {
  const calls: { url: string; body?: any }[] = [];
  const { runner } = runnerWith({ "ai.ollama.endpoint": "http://127.0.0.1:9" }, async (url, init) => {
    calls.push({ url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "gemma4:e4b", size: 9.6e9 }, { name: "qwen3.5:4b", size: 3.3e9 }] }));
    return ndjson("Scene ", "2.");
  });
  const sink = collect();
  const started = await runner.start("w1", request(), sink.emit);
  assert.deepEqual([started.provider, started.model], ["ollama", "qwen3.5:4b"]);
  assert.deepEqual(await sink.finished, { id: "r1", type: "done", text: "Scene 2." });
  assert.deepEqual(sink.events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text), ["Scene ", "2."]);
  const chat = calls.find((c) => c.url.endsWith("/api/chat"))!;
  assert.equal(chat.body.model, "qwen3.5:4b");
  assert.equal(chat.body.messages[0].content, "SYSTEM");
});

test("a model chosen in Settings wins, and the tier picks Anthropic's model", async () => {
  const seen: any[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    // The automatic pick lists the models first; this key lists nothing newer than the built-in.
    if (init.method === "GET") return new Response(JSON.stringify({ data: [] }));
    seen.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
    return new Response(ANTHROPIC_OK);
  };
  const { runner } = runnerWith({ "ai.provider": "anthropic" }, fetchFn);
  runner.setKey("anthropic", "sk-ant-x");
  for (const tier of ["fast", "smart"] as const) {
    const sink = collect();
    await runner.start("w1", request({ id: tier, tier }), sink.emit);
    await sink.finished;
  }
  assert.deepEqual(seen.map((s) => s.body.model), ["claude-haiku-5-5", "claude-sonnet-5-5"]);
  assert.equal(seen[0].headers["x-api-key"], "sk-ant-x");
  const custom = runnerWith({ "ai.provider": "anthropic", "ai.model.anthropic": "claude-opus-5-5" }, fetchFn);
  custom.runner.setKey("anthropic", "k");
  const sink = collect();
  const started = await custom.runner.start("w1", request(), sink.emit);
  assert.equal(started.model, "claude-opus-5-5");
  await sink.finished;
});

test("a provider without a key refuses to start", async () => {
  const { runner } = runnerWith({ "ai.provider": "openai" }, async () => new Response("{}"));
  await assert.rejects(runner.start("w1", request(), () => undefined), /No API key is set for openai/);
});

test("provider errors arrive as an error event", async () => {
  const { runner } = runnerWith({ "ai.provider": "google" }, async () => new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 400 }));
  runner.setKey("google", "bad");
  const sink = collect();
  await runner.start("w1", request(), sink.emit);
  const end = await sink.finished;
  assert.equal(end.type, "error");
  assert.match((end as { message: string }).message, /API key not valid/);
  assert.equal((end as { code: string }).code, "unauthorized");
});

test("cancel aborts the request and reports it", async () => {
  const { runner } = runnerWith({ "ai.ollama.endpoint": "http://x", "ai.model.ollama": "m" }, async (_url, init) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: "Hi" } }) + "\n"));
      init.signal!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
    },
  })));
  const sink = collect();
  await runner.start("w1", request(), sink.emit);
  runner.cancel("other-window", "r1");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sink.events.at(-1)?.type, "delta", "another window can not cancel it");
  runner.cancel("w1", "r1");
  const end = await sink.finished;
  assert.equal((end as { code: string }).code, "cancelled");
});

test("the Backlot summary joins the system prompt, read-only", async () => {
  const dir = folder();
  const path = join(dir, "project.json");
  writeFileSync(path, JSON.stringify(project()));
  const before = readFileSync(path, "utf8");
  let system = "";
  const { runner } = runnerWith({ "ai.ollama.endpoint": "http://x", "ai.model.ollama": "m", [AI_SETTINGS.backlotPath]: path }, async (_url, init) => {
    system = JSON.parse(String(init.body)).messages[0].content;
    return ndjson("ok");
  });
  const sink = collect();
  await runner.start("w1", request({ backlot: true }), sink.emit);
  await sink.finished;
  assert.match(system, /^SYSTEM/);
  assert.match(system, /Backlot project "Test Film"/);
  assert.match(system, /stunts: car flip/);
  assert.equal(readFileSync(path, "utf8"), before);
  // Without the flag it is not added.
  const plain = collect();
  await runner.start("w1", request({ id: "r2" }), plain.emit);
  await plain.finished;
  assert.equal(system, "SYSTEM");
});

test("only a Backlot project chosen in the main process's dialog is read; a page cannot name one", async () => {
  const path = join(folder(), "project.json");
  writeFileSync(path, JSON.stringify(project()));
  // The setting a page could write before: now ignored.
  let system = "";
  const { runner } = runnerWith({ "ai.ollama.endpoint": "http://x", "ai.model.ollama": "m", "backlot.projectPath": path }, async (_url, init) => {
    system = JSON.parse(String(init.body)).messages[0].content;
    return ndjson("ok");
  });
  const sink = collect();
  await runner.start("w1", request({ backlot: true }), sink.emit);
  await sink.finished;
  assert.equal(system, "SYSTEM");
  // The chosen project lives under grants.*, which settings:set refuses.
  assert.match(AI_SETTINGS.backlotPath, /^grants\./);
  const handlers = new Map<string, Handler>();
  registerSettings({ handle: (channel: string, handler: Handler) => void handlers.set(channel, handler), settings: { set: () => undefined } } as unknown as ServiceContext);
  assert.throws(() => handlers.get(CHANNELS.settingsSet)!({} as never, AI_SETTINGS.backlotPath, path), /managed by the app/);
});

test("without the direct ChatGPT provider, ChatGPT requests fail closed", async () => {
  const keys = new KeyStore(join(folder(), "keys.json"), cipher);
  const runner = new AiRunner({ setting: (key) => ({ "ai.provider": "chatgpt" } as Record<string, unknown>)[key] as never, keys, fetch: async () => new Response("{}") });
  await assert.rejects(runner.start("w1", request(), () => undefined), (error: AiError) => error.code === "not-configured" && /not available/.test(error.message));
  const status = await runner.status();
  assert.equal(status.providers.find((p) => p.provider === "chatgpt")?.ready, false);
  assert.match((await runner.test("chatgpt")).message, /not available/);
});

test("connection test for Ollama names the problem", async () => {
  const up = runnerWith({ "ai.ollama.endpoint": "http://x", "ai.model.ollama": "ghost:1b" }, async () => new Response(JSON.stringify({ models: [{ name: "qwen3.5:4b" }] })));
  assert.deepEqual(await up.runner.test("ollama"), { ok: false, message: "Ollama is running, but ghost:1b is not installed." });
  const fine = runnerWith({ "ai.ollama.endpoint": "http://x" }, async () => new Response(JSON.stringify({ models: [{ name: "qwen3.5:4b" }] })));
  const result = await fine.runner.test("ollama");
  assert.equal(result.ok, true);
  assert.equal(result.model, "qwen3.5:4b");
  const down = runnerWith({}, async () => { throw new TypeError("fetch failed"); });
  const failed = await down.runner.test("ollama");
  assert.equal(failed.ok, false);
  assert.match(failed.message, /not running/);
});

function project() {
  return {
    meta: { title: "Test Film" },
    script: {
      characters: [{ id: "c1", name: "MAYA" }, { id: "c2", name: "RAY" }],
      sets: [{ id: "s1", name: "WAREHOUSE" }],
      scenes: [
        { id: "a", number: "1", heading: "INT. WAREHOUSE - NIGHT", setId: "s1", pagesEighths: 10, characterIds: ["c1", "c2"],
          elements: [{ id: "e1", category: "Stunts", text: "car flip" }, { id: "e2", category: "Props", text: "crowbar", quantity: 2 }] },
        { id: "b", number: "2", heading: "EXT. ROAD - DAY", setId: "s1", characterIds: ["c1"], elements: [] },
        { id: "c", number: "3", heading: "INT. CAR - DAY", status: "omitted", characterIds: [], elements: [] },
      ],
    },
    schedule: { items: [
      { kind: "strip", id: "i1", sceneId: "a" }, { kind: "dayBreak", id: "d1", label: "Warehouse" },
      { kind: "strip", id: "i2", sceneId: "b" },
    ] },
  };
}

test("Backlot summary lists elements, cast and shoot day per scene", () => {
  const summary = summarizeBacklot(project());
  assert.equal(summary.scenes, 3);
  const lines = summary.text.split("\n");
  assert.match(summary.text, /3 scenes, 2 shoot days/);
  assert.match(lines.find((l) => l.startsWith("- 1."))!, /1\. INT\. WAREHOUSE - NIGHT \| 1 2\/8 pages \| cast: MAYA, RAY \| stunts: car flip \| props: crowbar x2 \| scheduled day 1 Warehouse/);
  assert.match(lines.find((l) => l.startsWith("- 2."))!, /scheduled day 2$/);
  assert.match(lines.find((l) => l.startsWith("- 3."))!, /\(omitted\).*not scheduled/);
  assert.throws(() => summarizeBacklot({ nope: 1 }), /not a Backlot project/);
});

test("a long Backlot summary shrinks to essentials, then truncates", () => {
  const big = project();
  big.script.scenes = Array.from({ length: 300 }, (_, i) => ({
    id: `s${i}`, number: String(i + 1), heading: `INT. PLACE ${i} - DAY`, setId: "s1", characterIds: ["c1"],
    elements: [{ id: "x", category: "Props", text: "a long prop name ".repeat(4) }, { id: "y", category: "Stunts", text: "fall" }],
  })) as never;
  const compact = summarizeBacklot(big, 20_000);
  assert.ok(compact.text.length <= 20_000);
  assert.ok(!compact.text.includes("a long prop"));
  assert.ok(compact.text.includes("stunts: fall"));
  const cut = summarizeBacklot(big, 3_000);
  assert.ok(cut.text.length <= 3_000);
  assert.ok(cut.text.endsWith("(summary shortened)"));
});

test("a request from the renderer is validated and its length capped", async () => {
  const bodies: any[] = [];
  const { runner } = runnerWith({ "ai.ollama.endpoint": "http://127.0.0.1:9", "ai.model.ollama": "m" }, async (url, init) => {
    if (init.body) bodies.push(JSON.parse(String(init.body)));
    return ndjson("ok");
  });
  await assert.rejects(runner.start("w", { ...request(), system: undefined } as unknown as AiRequest, () => undefined), /instructions/);
  await assert.rejects(runner.start("w", { ...request(), messages: [null, { role: "user", content: 4 }] } as unknown as AiRequest, () => undefined), /first message/);
  const sink = collect();
  await runner.start("w", request({ maxTokens: 1e9 }), sink.emit);
  await sink.finished;
  assert.equal(bodies[0].options.num_predict, 16000);
});

/** A keyed provider whose list request and chat requests are answered by the given functions, with every call logged. */
function keyed(provider: "anthropic" | "openai" | "google", list: (signal: AbortSignal) => Promise<Response>, chat: (model: string) => Response, settings: Record<string, unknown> = {}) {
  const lists: string[] = [];
  const models: string[] = [];
  const { runner } = runnerWith({ "ai.provider": provider, ...settings }, async (url, init) => {
    if (init.method === "GET") { lists.push(url); return list(init.signal!); }
    const model = JSON.parse(String(init.body)).model;
    models.push(model);
    return chat(model);
  });
  runner.setKey(provider, "test-key");
  const ask = async (extra: Partial<AiRequest> = {}) => {
    const sink = collect();
    const started = await runner.start("w", request({ id: `r${Math.random()}`, ...extra }), sink.emit);
    return { started, end: await sink.finished, events: sink.events };
  };
  return { runner, lists, models, ask };
}

const listing = (...ids: string[]) => async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }));

test("with no model chosen, the newest listed model in the line is used, and the list is cached", async () => {
  const { lists, models, ask, runner } = keyed("anthropic", listing("claude-sonnet-5-6", "claude-haiku-4-5-20251001", "claude-opus-6-0"), () => new Response(ANTHROPIC_OK));
  const smart = await ask({ tier: "smart" });
  assert.equal(smart.started.model, "claude-sonnet-5-6");
  assert.equal(smart.end.type, "done");
  await ask({ tier: "fast" });
  assert.deepEqual(models, ["claude-sonnet-5-6", "claude-haiku-5-5"]);
  assert.equal(lists.length, 1);
  assert.ok(lists.every((url) => url.startsWith("https://api.anthropic.com/v1/models")));
  // The Settings list says what Automatic means, and refreshes the same cache.
  assert.deepEqual((await runner.models("anthropic")).automatic, { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-6" });
  assert.equal(lists.length, 2);
  await ask();
  assert.equal(lists.length, 2);
});

test("a failed list gives the built-in model and is not retried for a few minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { lists, models, ask } = keyed("openai", async () => new Response("{}", { status: 500 }), () => new Response(OPENAI_OK));
  assert.equal((await ask()).started.model, "gpt-6.2-sol");
  assert.equal((await ask()).end.type, "done");
  assert.deepEqual([lists.length, models], [1, ["gpt-6.2-sol", "gpt-6.2-sol"]]);
  t.mock.timers.tick(5 * 60_000 + 1);
  await ask();
  assert.equal(lists.length, 2);
});

test("a slow list gives the built-in model after a few seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ask } = keyed("google", (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`));
  const pending = ask();
  t.mock.timers.tick(4000);
  const { started, end } = await pending;
  assert.equal(started.model, "gemini-4-hydrogen");
  assert.equal(end.type, "done");
});

test("cancelling while the list loads reports a cancelled request", async () => {
  const { runner } = keyed("google", (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))), () => new Response("{}"));
  const started = runner.start("w", request(), () => undefined);
  runner.cancel("w", "r1");
  await assert.rejects(started, (error: AiError) => error.code === "cancelled");
});

test("concurrent requests share one list request, and a chosen model makes none", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { lists, ask } = keyed("openai", async () => { await gate; return listing("gpt-6.3-sol")(); }, () => new Response(OPENAI_OK));
  const both = Promise.all([ask(), ask()]);
  release();
  assert.deepEqual((await both).map((r) => r.started.model), ["gpt-6.3-sol", "gpt-6.3-sol"]);
  assert.equal(lists.length, 1);
  const chosen = keyed("openai", listing("gpt-6.3-sol"), () => new Response(OPENAI_OK), { "ai.model.openai": "gpt-6.1-sol" });
  assert.equal((await chosen.ask()).started.model, "gpt-6.1-sol");
  assert.deepEqual([chosen.lists.length, chosen.models], [0, ["gpt-6.1-sol"]]);
});

test("a newer pick the provider refuses is retried once with the built-in, and not picked again", async () => {
  const refuse = (model: string) => model === "gpt-6.3-sol" ? new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_output_tokens'." } }), { status: 400 }) : new Response(OPENAI_OK);
  const { models, ask, runner } = keyed("openai", listing("gpt-6.3-sol"), refuse);
  const first = await ask();
  assert.equal(first.started.model, "gpt-6.3-sol", "start reports the pick; the retry happens after");
  assert.deepEqual(first.end, { id: first.end.id, type: "done", text: "ok" });
  assert.deepEqual(models, ["gpt-6.3-sol", "gpt-6.2-sol"]);
  const second = await ask();
  assert.equal(second.started.model, "gpt-6.2-sol");
  assert.deepEqual(models, ["gpt-6.3-sol", "gpt-6.2-sol", "gpt-6.2-sol"]);
  assert.equal((await runner.models("openai")).automatic?.smart, "gpt-6.2-sol");
});

test("a request both models refuse does not count against the newer pick", async () => {
  let refuse = true;
  const { models, ask } = keyed("openai", listing("gpt-6.3-sol"), () => refuse ? new Response(JSON.stringify({ error: { message: "Input is too long." } }), { status: 400 }) : new Response(OPENAI_OK));
  assert.equal((await ask()).end.type, "error");
  refuse = false;
  assert.equal((await ask()).started.model, "gpt-6.3-sol");
  assert.deepEqual(models, ["gpt-6.3-sol", "gpt-6.2-sol", "gpt-6.3-sol"]);
});

test("a newer pick that is down is answered by the built-in", async () => {
  for (const message of ["The model is unavailable.", "The model is overloaded."]) {
    const { models, ask } = keyed("openai", listing("gpt-6.3-sol"), (model) => model === "gpt-6.3-sol" ? new Response(JSON.stringify({ error: { message } }), { status: 503 }) : new Response(OPENAI_OK));
    assert.equal((await ask()).end.type, "done", message);
    assert.deepEqual(models, ["gpt-6.3-sol", "gpt-6.2-sol"], message);
  }
});

test("a tool turn refused on the newer pick is retried with the built-in", async () => {
  const tools = [{ name: "list_scenes", description: "List scenes", parameters: { type: "object", properties: {} } }];
  const { models, ask } = keyed("anthropic", listing("claude-sonnet-5-6"), (model) => model === "claude-sonnet-5-6"
    ? new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 })
    : new Response(JSON.stringify({ content: [{ type: "text", text: "Answer." }], stop_reason: "end_turn" })));
  const { end } = await ask({ tools });
  assert.deepEqual([end.type, models], ["done", ["claude-sonnet-5-6", "claude-sonnet-5-5"]]);
});

test("a key, limit or mid-stream failure on the newer pick is not retried", async () => {
  const cases: [() => Response, string][] = [
    [() => new Response(JSON.stringify({ error: { message: "Incorrect API key." } }), { status: 401 }), "unauthorized"],
    [() => new Response(JSON.stringify({ error: { message: "Slow down." } }), { status: 429 }), "rate-limited"],
    [() => new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Half" })}\n\ndata: ${JSON.stringify({ type: "response.failed", response: { error: { message: "Stopped." } } })}\n\n`), "failed"],
  ];
  for (const [answer, code] of cases) {
    const { models, ask } = keyed("openai", listing("gpt-6.3-sol"), answer);
    const { end } = await ask();
    assert.equal((end as { code: string }).code, code);
    assert.deepEqual(models, ["gpt-6.3-sol"], code);
  }
});
