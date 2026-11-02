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

test("an answer before reading any script gets one reminder, then ends with what the model says", async () => {
  const h = harness([{ text: "No evidence." }, { text: "Still no evidence." }]);
  const answer = await runAgent(h.options);
  assert.equal(answer.text, "Still no evidence.");
  assert.equal(h.requests.length, 2);
  assert.match(h.requests[1]!.messages.at(-1)!.content, /not read any of the script/);
  assert.equal(answer.coverage, "Read 0 of 1 scene");
});

test("an answer after reading ends at once and counts the scenes read", async () => {
  const h = harness([{ text: "", toolCalls: [call("read_scene", { scene: "12" })] }, { text: "Scene 12 has the gun." }]);
  const answer = await runAgent(h.options);
  assert.equal(h.requests.length, 2);
  assert.equal(answer.coverage, "Read 1 of 1 scene");
});

test("lookups that answer without reading a scene are named in the coverage line", async () => {
  // Terra beta 5: an answer built from character lookups showed only "Read 0 of 77 scenes".
  const h = harness([{ text: "", toolCalls: [call("character", { name: "Nell" }), call("search_script", { query: "gun" }, "c2"), call("list_scenes", {}, "c3")] },
    { text: "Nell first appears in scene 12." }]);
  const answer = await runAgent(h.options);
  assert.equal(answer.coverage, "Used the scene list, 1 character lookup, 1 search; read 0 of 1 scene");
});

test("an edit written as text is sent back once to be proposed", async () => {
  const h = harness([{ text: "", toolCalls: [call("read_scene", { scene: "12" })] }, { text: 'Cut "Nell holds a gun." to tighten it.' },
    { text: "", toolCalls: [call("propose_edit", { scene: "12", find: "Nell holds a gun.", replace: "Nell waits.", why: "Tighter." }, "c2")] }, { text: "Proposed." }]);
  h.options.request = { ...h.options.request, messages: [{ role: "user", content: "Tighten scene 12." }] };
  const answer = await runAgent(h.options);
  assert.match(h.requests[2]!.messages.at(-1)!.content, /call propose_edit/i);
  assert.equal(answer.proposals.length, 1);
  assert.equal(answer.text, "Proposed.");
});

test("no edit reminder when the writer did not ask for a change, or once the reading limit is reached", async () => {
  const quoted = { text: 'Scene 12 says "Nell holds a gun." and the gun changes hands later.' };
  const h = harness([{ text: "", toolCalls: [call("read_scene", { scene: "12" })] }, quoted]);
  h.options.request = { ...h.options.request, messages: [{ role: "user", content: "List continuity issues. Don't suggest changes." }] };
  assert.equal((await runAgent(h.options)).text, quoted.text);
  assert.equal(h.requests.length, 2);
  const limited = harness([{ text: "", toolCalls: [call("read_scene", { scene: "12" })] }, { text: "", toolCalls: [call("read_scene", { scene: "12" }, "c2")] },
    { text: 'Cut "Nell holds a gun." to tighten it.' }]);
  limited.options.request = { ...limited.options.request, messages: [{ role: "user", content: "Trim scene 12." }] };
  limited.options.resultBudget = 120;
  assert.equal((await runAgent(limited.options)).text, 'Cut "Nell holds a gun." to tighten it.');
});

test("calls past the per-turn limit are reported as skipped so the model can ask again", async () => {
  const h = harness([{ text: "", toolCalls: [call("read_scene", { scene: "12" })], skippedCalls: 3 }, { text: "Done." }]);
  await runAgent(h.options);
  assert.match(h.requests[1]!.messages.at(-1)!.content, /3 more were skipped/);
});

test("at the reading limit the model gets one turn to answer from what it read", async () => {
  const h = harness([{ text: "", toolCalls: [call("read_scene", { scene: "12" })] }, { text: "", toolCalls: [call("read_scene", { scene: "12" }, "c2")] },
    { text: "From scene 12: no issues." }]);
  h.options.resultBudget = 120;
  const answer = await runAgent(h.options);
  assert.equal(answer.text, "From scene 12: no issues.");
  assert.match(h.requests[2]!.messages.at(-1)!.content, /reading limit is reached/);
  const again = harness([{ text: "", toolCalls: [call("read_scene", { scene: "12" })] }, { text: "", toolCalls: [call("read_scene", { scene: "12" }, "c2")] },
    { text: "", toolCalls: [call("read_scene", { scene: "12" }, "c3")] }]);
  again.options.resultBudget = 120;
  assert.match((await runAgent(again.options)).note!, /Tool result limit/);
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
  const h = harness([new AiClientError("tool-parse", "Bad arguments"), { text: "", toolCalls: [call("read_scene", { scene: "12" })] }, { text: "Answer." }]);
  assert.equal((await runAgent(h.options)).note, undefined);
  assert.equal(h.requests.length, 3);
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
  const h = harness([{ text: "", reasoning, toolCalls: [{ ...call("read_scene", { scene: "12" }), signature: "signed", namespace: "screenplay" }] }, { text: "Done" }]);
  await runAgent(h.options);
  assert.deepEqual(h.requests[1]!.messages[1]!.reasoning, reasoning);
  assert.equal(h.requests[1]!.messages[1]!.toolCalls![0]!.signature, "signed");
});

test("only a request for a change counts as asking for an edit", async () => {
  const { asksForEdit } = await import("../src/renderer/features/assistant/agent.ts");
  for (const yes of ["Trim scene 12.", "Suggest one dialogue trim in scene 11.", "Tighten scene 12.", "Can you propose a cut in scene 3?", "Please rewrite Nell's line.", "Can you trim scene 12?", "Could you tighten this speech?"]) {
    assert.equal(asksForEdit(yes), true, yes);
  }
  for (const no of ["Does Nell replace the gun in scene 12?", "Check continuity. Don't rewrite anything.", "List continuity issues. Don't suggest changes.",
    "Where does the gun change hands?", "Which scenes is the lead in?", "Summarize scene 4 without suggesting edits.",
    "Does Nell suggest a change in scene 12?"]) {
    assert.equal(asksForEdit(no), false, no);
  }
});
