import { MAX_TOOL_CALLS, type AiMessage, type AiRequest, type AiStarted, type AiTurn } from "../../../shared/channels/ai.ts";
import { AiClientError, runAiTurn, type AiTurnRun } from "./client.ts";
import type { Suggestion } from "./suggestions.ts";
import { executeTool, scriptTools, type ToolContext } from "./tools.ts";

export const MAX_AGENT_STEPS = 12;
export const TOOL_RESULT_BUDGET = 120_000;
export const FALLBACK_NOTE = "Tool calls could not be read. Used the trimmed script.";
const stepLimit = (proposals: Suggestion[]): AgentAnswer => ({ text: "Stopped after 12 steps. Ask about a smaller part of the script to continue.", proposals, note: "Step limit reached" });

export interface AgentAnswer {
  text: string;
  proposals: Suggestion[];
  note?: string;
}

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

export async function runAgent(options: AgentOptions): Promise<AgentAnswer> {
  const { signal, context } = options;
  const run = options.run ?? runAiTurn;
  const messages: AiMessage[] = [...options.request.messages];
  const tools = scriptTools(!!context.productionData);
  const proposals: Suggestion[] = [];
  let remaining = Math.max(0, Math.min(options.resultBudget ?? TOOL_RESULT_BUDGET, TOOL_RESULT_BUDGET));
  let parseFailures = 0;
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
      if (step === MAX_AGENT_STEPS - 1) return stepLimit(proposals);
      options.onStep?.("Using the trimmed script");
      const answer = await request(options.fallback, options.onDelta);
      return { text: answer.text, proposals, note: FALLBACK_NOTE };
    }
    if (!turn.toolCalls?.length) return { text: turn.text, proposals };
    messages.push({ role: "assistant", content: "", toolCalls: turn.toolCalls, ...(turn.reasoning ? { reasoning: turn.reasoning } : {}) });
    // Main validates batches. This also bounds work with an injected transport in tests.
    if (turn.toolCalls.length > MAX_TOOL_CALLS) throw new AiClientError("tool-parse", "Too many tool calls.");
    // Reserve enough room for a valid error result for every remaining call in this batch.
    const budgetError = JSON.stringify({ ok: false, error: "Tool result budget reached. Answer from the evidence already read." });
    if (remaining < budgetError.length * turn.toolCalls.length) return { text: "Stopped at the script reading limit.", proposals, note: "Tool result limit reached" };
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
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
      options.onStep?.(fits ? executed.line : "Script reading limit reached");
      if (executed.proposal) {
        const proposal = executed.proposal;
        if (!proposals.some((item) => item.scene === proposal.scene && item.find === proposal.find && item.replace === proposal.replace)) {
          proposals.push(proposal);
          options.onProposal?.(proposal);
        }
      }
    }
    if (step === MAX_AGENT_STEPS - 2) messages.push({ role: "user", content: "This is the last step. Answer now from the evidence already read, without further tool calls." });
  }
  return stepLimit(proposals);
}
