import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFountain, ScreenplayDoc } from "@screenplay/engine";
import type { App } from "../src/renderer/core/app.ts";
import { AI_CHANNELS, AI_SETTINGS, type AiEvent, type AiRequest } from "../src/shared/channels/ai.ts";

const listeners = new Set<(event: AiEvent) => void>();
let handle: (channel: string, ...args: unknown[]) => unknown;
const bridge = {
  invoke: async <T,>(channel: string, ...args: unknown[]): Promise<T> => await handle(channel, ...args) as T,
  on: (_channel: string, listener: (event: AiEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
};
Object.assign(globalThis, { window: { desktop: bridge } });
const { Chat } = await import("../src/renderer/features/assistant/chat.ts");
const { runAiTurn } = await import("../src/renderer/features/assistant/client.ts");
const emit = (event: AiEvent) => { for (const listener of [...listeners]) listener(event); };

function harness(settings: Record<string, unknown> = {}) {
  listeners.clear();
  const script = parseFountain("INT. ROOM - DAY #12#\n\nNell holds a gun. [[PRIVATE NOTE]]\n");
  const doc = new ScreenplayDoc(); doc.load(script);
  let sessionChanged: () => void = () => undefined;
  const app = { session: { script: () => script, doc }, editor: null,
    onSession: (listener: () => void) => { sessionChanged = listener; return () => undefined; },
    setting: (key: string, fallback: unknown) => settings[key] ?? fallback } as unknown as App;
  const chat = new Chat(app);
  const requests: AiRequest[] = [], cancelled: string[] = [];
  handle = (channel, ...args) => {
    if (channel === AI_CHANNELS.status) return { active: { provider: "ollama", contextChars: 36000 }, providers: [{ provider: "ollama", ready: true }] };
    if (channel === AI_CHANNELS.cancel) { cancelled.push(String(args[0])); return; }
    if (channel === AI_CHANNELS.start) {
      const request = args[0] as AiRequest; requests.push(request);
      // A tool-enabled model reads the scene first, as the agent expects, then answers.
      const read = request.tools && !request.messages.some((message) => message.role === "tool");
      emit(read ? { id: request.id, type: "done", text: "", toolCalls: [{ id: `read-${requests.length}`, name: "read_scene", arguments: { scene: "12" } }] }
        : { id: request.id, type: "done", text: "Scene 12." });
      return { id: request.id, provider: "ollama", model: "test" };
    }
  };
  return { chat, requests, cancelled, sessionChanged: () => sessionChanged(), dispose: () => doc.ydoc.destroy() };
}

test("Chat uses tools by default without sending a whole-script snapshot", async (t) => {
  const h = harness(); t.after(h.dispose);
  await h.chat.send("Where is the gun?");
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests[0]!.tools?.length);
  assert.doesNotMatch(h.requests[0]!.system, /Nell holds|PRIVATE NOTE/);
  assert.match(h.requests[0]!.system, /propose_edit/);
  assert.equal(h.chat.messages.at(-1)!.text, "Scene 12.");
  assert.equal(h.chat.busy, false);
  assert.equal(listeners.size, 0);
});

test("Chat checkbox off preserves the single request with trimmed Fountain", async (t) => {
  const h = harness({ [AI_SETTINGS.wholeScript]: false }); t.after(h.dispose);
  await h.chat.send("Where is the gun?");
  assert.equal(h.requests[0]!.tools, undefined);
  assert.match(h.requests[0]!.system, /Nell holds a gun/);
  assert.doesNotMatch(h.requests[0]!.system, /PRIVATE NOTE/);
  assert.match(h.chat.messages.at(-1)!.note!, /whole script sent/);
});

test("Chat propagates tool-parse errors and exposes the fallback in the footer", async (t) => {
  const h = harness(); t.after(h.dispose);
  const original = handle;
  handle = (channel, ...args) => {
    const request = args[0] as AiRequest;
    if (channel !== AI_CHANNELS.start || !request.tools) return original(channel, ...args);
    h.requests.push(request);
    emit({ id: request.id, type: "error", code: "tool-parse", message: "Invalid tool call" });
    return { id: request.id, provider: "ollama", model: "test" };
  };
  await h.chat.send("Check continuity");
  assert.equal(h.requests.length, 3);
  assert.match(h.chat.messages.at(-1)!.note!, /Used the trimmed script/);
  assert.equal(h.chat.messages.at(-1)!.toolAnswer, false);
  assert.match(h.requests[2]!.system, /Nell holds a gun/);
});

test("Chat session changes cancel the loop and discard late calls and answers", async (t) => {
  const h = harness(); t.after(h.dispose);
  const original = handle;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let request!: AiRequest;
  handle = (channel, ...args) => {
    if (channel !== AI_CHANNELS.start) return original(channel, ...args);
    request = args[0] as AiRequest; h.requests.push(request); started();
    return { id: request.id, provider: "ollama", model: "test" };
  };
  const pending = h.chat.send("Check continuity");
  await entered;
  h.sessionChanged();
  emit({ id: request.id, type: "done", text: "", toolCalls: [{ id: "late", name: "list_scenes", arguments: {} }] });
  await pending;
  assert.deepEqual(h.chat.messages, []);
  assert.equal(h.chat.busy, false);
  assert.equal(h.requests.length, 1);
  assert.ok(h.cancelled.includes(request.id));
  assert.equal(listeners.size, 0);
});

test("Chat stop cancels model discovery and leaves a stopped answer", async (t) => {
  const h = harness(); t.after(h.dispose);
  const original = handle;
  let started!: () => void, finish!: (value: unknown) => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  handle = (channel, ...args) => {
    if (channel !== AI_CHANNELS.start) return original(channel, ...args);
    h.requests.push(args[0] as AiRequest); started();
    return new Promise((resolve) => { finish = resolve; });
  };
  const pending = h.chat.send("Read the script");
  await entered; h.chat.stop(); await pending;
  assert.equal(h.chat.messages.at(-1)!.note, "Stopped");
  assert.equal(h.chat.messages.at(-1)!.streaming, false);
  assert.equal(h.chat.busy, false);
  finish({ id: h.requests[0]!.id, provider: "ollama", model: "test" });
  assert.equal(listeners.size, 0);
});

test("Chat offers production_data only when the project and inclusion are both set", async (t) => {
  const h = harness({ [AI_SETTINGS.backlotPath]: "/chosen/project.json" }); t.after(h.dispose);
  await h.chat.send("Production?", { backlot: false });
  await h.chat.send("Include production", { backlot: true });
  assert.ok(!h.requests[0]!.tools!.some((tool) => tool.name === "production_data"));
  assert.ok(h.requests[2]!.tools!.some((tool) => tool.name === "production_data"));
  assert.doesNotMatch(JSON.stringify(h.requests), /\/chosen\/project/);
});

test("client cancellation rejects immediately even before main acknowledges the request", async () => {
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { entered = resolve; });
  handle = (channel) => channel === AI_CHANNELS.start ? new Promise((resolve) => { finish = resolve; entered(); })
    : { active: { provider: "ollama" }, providers: [{ provider: "ollama", ready: true }] };
  const run = runAiTurn({ tier: "smart", system: "Read", messages: [{ role: "user", content: "Hi" }] });
  await pending;
  run.cancel();
  await assert.rejects(run.done, /Cancelled/);
  finish({ id: run.id, provider: "ollama", model: "test" });
  await run.started;
  assert.equal(listeners.size, 0);
});

test("the continuity check says what it needs instead of running on the local model", async (t) => {
  const h = harness(); t.after(h.dispose);
  await h.chat.quick("continuity");
  assert.equal(h.requests.length, 0);
  assert.match(h.chat.messages.at(-1)!.error!, /needs ChatGPT or an API key/);
  await h.chat.quick("summarize");
  assert.equal(h.requests.length > 0, true, "scene actions still run locally");
});

test("a continuity action from a document that was switched away does nothing", async (t) => {
  const h = harness(); t.after(h.dispose);
  const pending = h.chat.quick("continuity");
  h.sessionChanged();
  await pending;
  assert.equal(h.requests.length, 0);
  assert.equal(h.chat.messages.length, 0);
});

test("setup replaces missing-provider errors once, quiet requests stay silent, and Chat retries once", async (t) => {
  const h = harness(); t.after(h.dispose);
  const original = handle;
  const { app } = await import("../src/renderer/core/app.ts");
  const { aiSetupReady } = await import("../src/renderer/features/assistant/setup.ts");
  let ready = false, offers = 0;
  handle = (channel, ...args) => {
    if (channel === AI_CHANNELS.status) return { active: { provider: "ollama", contextChars: 36000 }, providers: [{ provider: "ollama", ready }] };
    if (channel === AI_CHANNELS.offerSetup) { offers++; return true; }
    return original(channel, ...args);
  };
  const quiet = runAiTurn({ tier: "fast", system: "Complete", messages: [] }, undefined, { quiet: true });
  await assert.rejects(quiet.done, (e: any) => e.setupRequired && e.message === "Set up AI to use this feature.");
  assert.equal(offers, 0);
  assert.equal(h.requests.length, 0);
  await h.chat.send("Where is the gun?");
  assert.equal(app.ui.modal?.id, "ai.setup");
  assert.equal(h.chat.messages.at(-1)?.setupRequired, true);
  assert.equal(offers, 1);
  app.closeModal();
  await h.chat.send("Which room?");
  assert.equal(app.ui.modal, null);
  assert.equal(offers, 1);
  ready = true;
  aiSetupReady();
  // The ready callback starts a new async request; allow its tools to finish.
  for (let i = 0; i < 50 && h.chat.busy; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.chat.messages.at(-1)?.text, "Scene 12.");
  assert.equal(h.requests.length, 2);
  assert.equal(h.chat.messages.filter((m) => m.role === "user" && m.text === "Which room?").length, 1);
});

test("coded discovery failures and streamed local failures both offer setup without exposing transport errors", async () => {
  for (const streamed of [false, true]) {
    handle = (channel, ...args) => {
      if (channel === AI_CHANNELS.status) return { active: { provider: "ollama" }, providers: [{ provider: "ollama", ready: true }] };
      if (channel === AI_CHANNELS.start) {
        const request = args[0] as AiRequest;
        if (!streamed) return { error: { code: "not-configured", message: "Run ollama pull" } };
        emit({ id: request.id, type: "error", code: "unreachable", message: "Ollama is not running at that address" });
        return { id: request.id, provider: "ollama", model: "test" };
      }
    };
    const run = runAiTurn({ tier: "smart", system: "Read", messages: [] });
    await assert.rejects(run.done, (e: any) => e.setupRequired && e.message === "Set up AI to use this feature.");
    assert.equal(listeners.size, 0);
  }
});

test("an unready cloud provider keeps its own message; only the local model opens setup", async () => {
  let starts = 0;
  handle = (channel) => {
    if (channel === AI_CHANNELS.status) return { active: { provider: "openai" }, providers: [{ provider: "openai", ready: false }, { provider: "ollama", ready: false }] };
    if (channel === AI_CHANNELS.start) { starts++; return { error: { code: "not-configured", message: "No API key is set for openai." } }; }
  };
  const run = runAiTurn({ tier: "fast", system: "Read", messages: [] });
  await assert.rejects(run.done, (e: any) => !e.setupRequired && /No API key/.test(e.message));
  assert.equal(starts, 1);
  const local = runAiTurn({ tier: "fast", system: "Read", messages: [], provider: "ollama" });
  await assert.rejects(local.done, (e: any) => e.setupRequired);
  assert.equal(starts, 1, "the local model is checked before any text is sent");
});
