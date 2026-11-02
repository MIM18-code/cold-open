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
    seen.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
    return new Response(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } })}\n\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
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
