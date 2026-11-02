import { scenesOf } from "@screenplay/engine";
import { MAX_TOOL_CALLS, type AiMessage, type AiRequest, type AiStarted, type AiTurn } from "../../../shared/channels/ai.ts";
import { AiClientError, runAiTurn, type AiTurnRun } from "./client.ts";
import { plainMarks, type Suggestion } from "./suggestions.ts";
import { executeTool, scriptTools, type ToolContext } from "./tools.ts";

export const MAX_AGENT_STEPS = 12;
export const TOOL_RESULT_BUDGET = 120_000;
export const FALLBACK_NOTE = "Tool calls could not be read. Used the trimmed script.";
const stepLimit = (proposals: Suggestion[]): AgentAnswer => ({ text: "Stopped after 12 steps. Ask about a smaller part of the script to continue.", proposals, note: "Step limit reached" });

export interface AgentAnswer {
  text: string;
  proposals: Suggestion[];
  note?: string;
  /** What the answer rests on, counted by the app rather than claimed by the model: "Used 2 character lookups; read 1 of 77 scenes". */
  coverage?: string;
}

// Small local models answer from a scene list alone, or write an edit as text instead of proposing it. One reminder
// each, sent as a user turn, usually gets the tool call; a second refusal is left to the coverage line.
const LOOK_FIRST = "Cold Open: you have not read any of the script yet. Use read_scene, search_script or character to read what your answer depends on, then answer.";
const PROPOSE = "Cold Open: an edit written in the answer can't be applied. Call propose_edit with the exact text from the scene.";
const AT_LIMIT = "Cold Open: the reading limit is reached. Answer now from the scenes you read, and say which scenes those were.";
// A valid proposal counts: propose_edit only accepts text that is in the scene.
const EVIDENCE = new Set(["read_scene", "search_script", "character", "production_data", "propose_edit"]);
// Only when the writer asked for a change, and the answer quotes a passage next to an edit verb.
const EDIT_WORDS = /\b(find|replace|cut|trim|remov|delet|rewrit|rephras|reword|chang|tighten|shorten|edit|fix|punch)\w*/i;
// A request, not a question about the story: "Trim scene 12." or "Suggest a cut in scene 11", never "Does Nell replace
// the gun?" or "Don't rewrite anything."
const EDIT_VERBS = "trim|cut|rewrite|rephrase|reword|tighten|shorten|fix|punch|edit|change|replace";
const EDIT_VERB = `(?:${EDIT_VERBS})`;
const IMPERATIVE = new RegExp(`(?:^|[.!?]\\s+|\\b(?:can|could|would|will)\\s+you\\s+)(?:please\\s+)?${EDIT_VERB}\\b`, "im");
// Addressed to the assistant: "Suggest a trim…" or "Can you propose a cut…", not "Does Nell suggest a change?"
const OFFER = new RegExp(`(?:(?:^|[.!?]\\s+)(?:please\\s+)?|\\b(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)(?:suggest|propose|recommend|give|offer|make|write|show)\\b[^.?!]{0,40}\\b${EDIT_VERB}`, "im");
const NEGATED = new RegExp(`\\b(?:don'?t|do not|never|without|no)\\b[^.?!]{0,25}\\b(?:${EDIT_VERBS}|suggest|propose)`, "i");
const asksForEdit = (question: string) => !NEGATED.test(plainMarks(question)) && (IMPERATIVE.test(question.trim()) || OFFER.test(question.trim()));
const writtenEdit = (question: string, text: string) => asksForEdit(question) && /["\u201c][^"\u201d\n]{3,}["\u201d]/.test(text) && EDIT_WORDS.test(text);

export interface AgentOptions {
  request: Omit<AiRequest, "id" | "tools">;
  fallback: Omit<AiRequest, "id" | "tools">;
  context: ToolContext;
  signal: AbortSignal;
  resultBudget?: number;
  onStep?(line: string): void;
  onProposal?(proposal: Suggestion): void;
  onStarted?(started: AiStarted): void;
  onDelta?(text: string): void;
  run?: (request: Omit<AiRequest, "id">, onDelta?: (text: string) => void) => AiTurnRun;
}

function check(signal: AbortSignal): void {
  if (signal.aborted) throw new AiClientError("cancelled", "Cancelled.");
}

/** Cancel even while waiting on model discovery or a production-data IPC reply. */
async function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  check(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new AiClientError("cancelled", "Cancelled.")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

/** Exported for tests. */
export { asksForEdit };

export async function runAgent(options: AgentOptions): Promise<AgentAnswer> {
  const { signal, context } = options;
  const run = options.run ?? runAiTurn;
  const messages: AiMessage[] = [...options.request.messages];
  const tools = scriptTools(!!context.productionData);
  const proposals: Suggestion[] = [];
  let remaining = Math.max(0, Math.min(options.resultBudget ?? TOOL_RESULT_BUDGET, TOOL_RESULT_BUDGET));
  let parseFailures = 0;
  const question = options.request.messages.findLast((message) => message.role === "user")?.content ?? "";
  const read = new Set<string>();
  let looked = false, limited = false, remindedLook = false, remindedPropose = false, atLimit = false;
  // Lookups answer some questions without reading a scene (line counts, first appearances), so they are named too.
  const used = { list_scenes: 0, character: 0, search_script: 0, production_data: 0 };
  const coverage = () => {
    const total = scenesOf(context.script().paragraphs).length;
    const scenes = `read ${read.size} of ${total} scene${total === 1 ? "" : "s"}`;
    const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
    const lookups = [used.list_scenes ? "the scene list" : "", used.character ? plural(used.character, "character lookup") : "",
      used.search_script ? plural(used.search_script, "search", "searches") : "", used.production_data ? "production data" : ""].filter(Boolean);
    return lookups.length ? `Used ${lookups.join(", ")}; ${scenes}` : scenes[0]!.toUpperCase() + scenes.slice(1);
  };
  const finish = (answer: AgentAnswer): AgentAnswer => ({ ...answer, coverage: coverage() });
  const request = async (body: Omit<AiRequest, "id">, delta?: (text: string) => void): Promise<AiTurn> => {
    check(signal);
    const active = run(body, delta);
    const cancel = () => active.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      options.onStarted?.(await cancellable(active.started, signal));
      const turn = await cancellable(active.done, signal);
      check(signal);
      return turn;
    } finally { signal.removeEventListener("abort", cancel); }
  };
  options.onStep?.("Looking through the script");
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    check(signal);
    let turn: AiTurn;
    try { turn = await request({ ...options.request, messages: [...messages], tools }); }
    catch (error) {
      check(signal);
      if (!(error instanceof AiClientError) || error.code !== "tool-parse") throw error;
      if (++parseFailures < 2) {
        options.onStep?.("Retrying tool call");
        continue;
      }
      if (step === MAX_AGENT_STEPS - 1) return finish(stepLimit(proposals));
      options.onStep?.("Using the trimmed script");
      const answer = await request(options.fallback, options.onDelta);
      return { text: answer.text, proposals, note: FALLBACK_NOTE };
    }
    if (!turn.toolCalls?.length) {
      const reminder = step >= MAX_AGENT_STEPS - 2 || limited ? undefined
        : !looked && !remindedLook ? (remindedLook = true, LOOK_FIRST)
        : !proposals.length && !remindedPropose && writtenEdit(question, turn.text) ? (remindedPropose = true, PROPOSE) : undefined;
      if (!reminder) return finish({ text: turn.text, proposals });
      messages.push({ role: "assistant", content: turn.text }, { role: "user", content: reminder });
      continue;
    }
    messages.push({ role: "assistant", content: "", toolCalls: turn.toolCalls, ...(turn.reasoning ? { reasoning: turn.reasoning } : {}) });
    // Main validates batches. This also bounds work with an injected transport in tests.
    if (turn.toolCalls.length > MAX_TOOL_CALLS) throw new AiClientError("tool-parse", "Too many tool calls.");
    // Reserve enough room for a valid error result for every remaining call in this batch.
    const budgetError = JSON.stringify({ ok: false, error: "Tool result budget reached. Answer from the evidence already read." });
    if (remaining < budgetError.length * turn.toolCalls.length) {
      if (atLimit) return finish({ text: "Stopped at the script reading limit.", proposals, note: "Tool result limit reached" });
      // One last turn to answer from what was read; these short results sit outside the budget.
      atLimit = limited = true;
      for (const call of turn.toolCalls) messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: budgetError });
      messages.push({ role: "user", content: AT_LIMIT });
      options.onStep?.("Script reading limit reached");
      continue;
    }
    for (let index = 0; index < turn.toolCalls.length; index++) {
      check(signal);
      const call = turn.toolCalls[index]!;
      const executed = await cancellable(executeTool(call, context), signal);
      check(signal);
      const result = JSON.stringify(executed.result);
      const available = remaining - budgetError.length * (turn.toolCalls.length - index - 1);
      const fits = result.length <= available;
      const content = fits ? result : budgetError;
      remaining -= content.length;
      if (!fits) limited = true;
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
      const outcome = executed.result as { ok?: boolean; scene?: unknown };
      if (fits && EVIDENCE.has(call.name) && outcome.ok !== false) looked = true;
      if (fits && call.name === "read_scene" && typeof outcome.scene === "string") read.add(outcome.scene);
      if (fits && outcome.ok !== false && call.name in used) used[call.name as keyof typeof used]++;
      options.onStep?.(fits ? executed.line : "Script reading limit reached");
      if (executed.proposal) {
        const proposal = executed.proposal;
        if (!proposals.some((item) => item.scene === proposal.scene && item.find === proposal.find && item.replace === proposal.replace)) {
          proposals.push(proposal);
          options.onProposal?.(proposal);
        }
      }
    }
    if (turn.skippedCalls) messages.push({ role: "user", content: `Cold Open: only ${MAX_TOOL_CALLS} tool calls run per turn, so ${turn.skippedCalls} more were skipped. Ask for them in your next turn if you still need them.` });
    if (step === MAX_AGENT_STEPS - 2) messages.push({ role: "user", content: "This is the last step. Answer now from the evidence already read, without further tool calls." });
  }
  return finish(stepLimit(proposals));
}
