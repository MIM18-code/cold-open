import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFountain } from "@screenplay/engine";
import type { AiRequest, AiToolCall, AiTurn } from "../src/shared/channels/ai.ts";
import type { AiTurnRun } from "../src/renderer/features/assistant/client.ts";
import type { AgentOptions } from "../src/renderer/features/assistant/agent.ts";

Object.assign(globalThis, { window: { desktop: { invoke: async () => undefined, on: () => () => undefined } } });
const { runAgent, MAX_AGENT_STEPS, FALLBACK_NOTE } = await import("../src/renderer/features/assistant/agent.ts");
const { AiClientError } = await import("../src/renderer/features/assistant/client.ts");
const script = () => parseFountain("INT. ROOM - DAY #12#\n\nNell holds a gun.\n\nNELL\nWait.\n");
const call = (name: string, args: Record<string, unknown> = {}, id = "c1"): AiToolCall => ({ id, name, arguments: args });

function harness(turns: (AiTurn | Error | (() => Promise<AiTurn>))[]) {
  const requests: Omit<AiRequest, "id">[] = [];
  let cancelled = 0;
  const run = (request: Omit<AiRequest, "id">, delta?: (text: string) => void): AiTurnRun => {
    requests.push(structuredClone(request));
    const next = turns.shift();
    const done = next instanceof Error ? Promise.reject(next) : typeof next === "function" ? next() : Promise.resolve(next!);
    done.catch(() => undefined);
    if (!request.tools) delta?.("fallback delta");
    return { id: "request", started: Promise.resolve({ id: "request", provider: "ollama", model: "test" }), done,
      cancel: () => { cancelled++; } };
  };
  const controller = new AbortController();
  const lines: string[] = [];
  const options: AgentOptions = {
    request: { tier: "smart", system: "Use tools", messages: [{ role: "user", content: "Where is the gun?" }] },
    fallback: { tier: "smart", system: "Trimmed script", messages: [{ role: "user", content: "Where is the gun?" }], backlot: true },
    context: { script }, signal: controller.signal, run, onStep: (line) => lines.push(line),
  };
  return { requests, controller, lines, options, cancelled: () => cancelled };
}

test("agent round trip executes tools and sends matching results with the full history", async () => {
  const h = harness([{ text: "", toolCalls: [call("search_script", { query: "gun" })] }, { text: "Scene 12 has the gun." }]);
  const answer = await runAgent(h.options);
  assert.equal(answer.text, "Scene 12 has the gun.");
  assert.equal(h.requests.length, 2);
  const history = h.requests[1]!.messages;
  assert.equal(history[0]!.content, "Where is the gun?");
  assert.equal(history[1]!.toolCalls![0]!.name, "search_script");
  assert.equal(history[2]!.role, "tool");
  assert.equal(history[2]!.toolCallId, "c1");
  assert.match(history[2]!.content, /Nell holds a gun/);
  assert.ok(h.lines.some((line) => /Searched for "gun" · 1 match/.test(line)));
});

test("agent ends immediately when the model answers without tools", async () => {
  const h = harness([{ text: "No evidence." }]);
  assert.equal((await runAgent(h.options)).text, "No evidence.");
  assert.equal(h.requests.length, 1);
});

test("agent retains validated proposals as cards and never edits the document", async () => {
  const s = script(), before = structuredClone(s);
  const h = harness([{ text: "", toolCalls: [call("propose_edit", { scene: "12", find: "Nell holds a gun.", replace: "Nell hides a gun.", why: "Continuity." })] }, { text: "Proposed a change in Scene 12." }]);
  h.options.context.script = () => s;
  const proposals: unknown[] = []; h.options.onProposal = (proposal) => proposals.push(proposal);
  const answer = await runAgent(h.options);
  assert.equal(answer.proposals.length, 1);
  assert.deepEqual(answer.proposals, proposals);
  assert.deepEqual(s, before);
  assert.match(h.requests[1]!.messages[2]!.content, /"ok":true/);
});

test("agent returns a precise edit error so the next turn can fix it", async () => {
  const args = { scene: "12", find: "Wrong text", replace: "New text", why: "Continuity." };
  const h = harness([{ text: "", toolCalls: [call("propose_edit", args)] },
    { text: "", toolCalls: [call("propose_edit", { ...args, find: "Nell holds a gun." }, "c2")] }, { text: "Proposed." }]);
  const answer = await runAgent(h.options);
  assert.match(h.requests[1]!.messages[2]!.content, /not in the script/);
  assert.equal(answer.proposals.length, 1);
});

test("agent enforces the 12 step cap", async () => {
  const h = harness(Array.from({ length: MAX_AGENT_STEPS }, (_, index) => ({ text: "", toolCalls: [call("list_scenes", {}, `c${index}`)] })));
  const answer = await runAgent(h.options);
  assert.equal(h.requests.length, MAX_AGENT_STEPS);
  assert.match(answer.note!, /Step limit/);
});

test("fallback cannot push the request count past the step cap", async () => {
  const rounds: (AiTurn | Error)[] = Array.from({ length: 10 }, (_, index) => ({ text: "", toolCalls: [call("list_scenes", {}, `c${index}`)] }));
  rounds.push(new AiClientError("tool-parse", "Bad arguments"), new AiClientError("tool-parse", "Bad arguments"));
  const h = harness(rounds);
  assert.match((await runAgent(h.options)).note!, /Step limit/);
  assert.equal(h.requests.length, MAX_AGENT_STEPS);
});

test("agent bounds the total serialized tool result characters", async () => {
  const h = harness([{ text: "", toolCalls: [call("read_scene", { scene: "12" })] }, { text: "Only partial evidence." }]);
  const s = script(); s.paragraphs[1]!.runs = [{ text: "x".repeat(5000) }];
  h.options.context.script = () => s;
  h.options.resultBudget = 200;
  await runAgent(h.options);
  const results = h.requests.at(-1)!.messages.filter((message) => message.role === "tool");
  assert.ok(results.reduce((sum, message) => sum + message.content.length, 0) <= 200);
  assert.match(results[0]!.content, /budget reached/);
  assert.doesNotThrow(() => JSON.parse(results[0]!.content));
});

test("agent stops before a request when already cancelled", async () => {
  const h = harness([]); h.controller.abort();
  await assert.rejects(runAgent(h.options), (error: Error) => error instanceof AiClientError && error.code === "cancelled");
  assert.equal(h.requests.length, 0);
});

test("agent cancellation stops a running model request without executing its eventual tool calls", async () => {
  let finish!: (turn: AiTurn) => void;
  const h = harness([() => new Promise((resolve) => { finish = resolve; })]);
  const pending = runAgent(h.options);
  await Promise.resolve(); await Promise.resolve();
  h.controller.abort();
  await assert.rejects(pending, (error: Error) => error instanceof AiClientError && error.code === "cancelled");
  finish({ text: "", toolCalls: [call("list_scenes")] });
  assert.equal(h.cancelled(), 1);
  assert.equal(h.requests.length, 1);
});

test("agent cancellation during production data drops its result and prevents the next turn", async () => {
  let enter!: () => void, finish!: (value: { ok: true; text: string }) => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const h = harness([{ text: "", toolCalls: [call("production_data")] }]);
  h.options.context.productionData = () => { enter(); return new Promise((resolve) => { finish = resolve; }); };
  const pending = runAgent(h.options);
  await entered;
  h.controller.abort();
  await assert.rejects(pending, /Cancelled/);
  finish({ ok: true, text: "Late production data" });
  assert.equal(h.requests.length, 1);
  assert.ok(!h.lines.includes("Read production data"));
});

test("agent falls back only after two unparseable tool turns, with a footer note", async () => {
  const failure = () => new AiClientError("tool-parse", "Bad tool arguments");
  const h = harness([failure(), failure(), { text: "Fallback answer." }]);
  const answer = await runAgent(h.options);
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests[0]!.tools?.length);
  assert.ok(h.requests[1]!.tools?.length);
  assert.deepEqual(h.requests[2], h.options.fallback);
  assert.equal(answer.text, "Fallback answer.");
  assert.equal(answer.note, FALLBACK_NOTE);
});

test("agent recovers from one parse failure without falling back", async () => {
  const h = harness([new AiClientError("tool-parse", "Bad arguments"), { text: "Answer." }]);
  assert.equal((await runAgent(h.options)).note, undefined);
  assert.equal(h.requests.length, 2);
});

test("agent never retries authorization, network or plan-limit errors", async () => {
  for (const code of ["unauthorized", "unreachable", "plan-limit"] as const) {
    const h = harness([new AiClientError(code, "Failed")]);
    await assert.rejects(runAgent(h.options), /Failed/);
    assert.equal(h.requests.length, 1);
  }
});

test("agent preserves encrypted reasoning and tool signatures in the next request", async () => {
  const reasoning = [{ id: "r", encryptedContent: "opaque", summary: [] }];
  const h = harness([{ text: "", reasoning, toolCalls: [{ ...call("list_scenes"), signature: "signed", namespace: "screenplay" }] }, { text: "Done" }]);
  await runAgent(h.options);
  assert.deepEqual(h.requests[1]!.messages[1]!.reasoning, reasoning);
  assert.equal(h.requests[1]!.messages[1]!.toolCalls![0]!.signature, "signed");
});
