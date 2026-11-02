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
    if (channel === AI_CHANNELS.status) return { active: { provider: "ollama", contextChars: 36000 }, providers: [] };
    if (channel === AI_CHANNELS.cancel) { cancelled.push(String(args[0])); return; }
    if (channel === AI_CHANNELS.start) {
      const request = args[0] as AiRequest; requests.push(request);
      emit({ id: request.id, type: "done", text: "Scene 12." });
      return { id: request.id, provider: "ollama", model: "test" };
    }
  };
  return { chat, requests, cancelled, sessionChanged: () => sessionChanged(), dispose: () => doc.ydoc.destroy() };
}

test("Chat uses tools by default without sending a whole-script snapshot", async (t) => {
  const h = harness(); t.after(h.dispose);
  await h.chat.send("Where is the gun?");
  assert.equal(h.requests.length, 1);
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
  assert.ok(h.requests[1]!.tools!.some((tool) => tool.name === "production_data"));
  assert.doesNotMatch(JSON.stringify(h.requests), /\/chosen\/project/);
});

test("client cancellation rejects immediately even before main acknowledges the request", async () => {
  let finish!: (value: unknown) => void;
  handle = (channel) => channel === AI_CHANNELS.start ? new Promise((resolve) => { finish = resolve; }) : undefined;
  const run = runAiTurn({ tier: "smart", system: "Read", messages: [{ role: "user", content: "Hi" }] });
  run.cancel();
  await assert.rejects(run.done, /Cancelled/);
  finish({ id: run.id, provider: "ollama", model: "test" });
  await run.started;
  assert.equal(listeners.size, 0);
});
