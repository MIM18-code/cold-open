// The renderer's side of "ai:start": send a request, get text as it streams, cancel. The provider and the key
// are the main process's business; this only knows the request ID.
import { CHANNELS } from "../../../shared/api.ts";
import { AI_CHANNELS, CHATGPT_USAGE_URL, PLAN_LIMIT_MESSAGE, type AiErrorCode, type AiEvent, type AiRequest, type AiStarted, type AiTurn } from "../../../shared/channels/ai.ts";
import { desktop, messageBox } from "../../core/platform.ts";

export class AiClientError extends Error {
  readonly code: AiErrorCode;
  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface AiRun {
  id: string;
  /** Resolves with the provider and model once the request is under way. */
  started: Promise<AiStarted>;
  /** Resolves with the whole answer. Rejects with AiClientError, code "cancelled" after cancel(). */
  done: Promise<string>;
  cancel(): void;
}

let counter = 0;
let planLimitShown = 0;

/** A plan limit, from any feature: OpenAI's guidelines put Manage usage first. Shown at most once a minute. */
function planLimit(code: AiErrorCode | undefined, message: string): void {
  if (code !== "plan-limit" && !message.includes(PLAN_LIMIT_MESSAGE)) return;
  if (Date.now() - planLimitShown < 60_000) return;
  planLimitShown = Date.now();
  void messageBox({ type: "warning", message: PLAN_LIMIT_MESSAGE,
    detail: "Review your plan or this app's limit in ChatGPT settings. Cold Open paused ChatGPT requests; resume them in Settings > AI.",
    buttons: ["Manage usage", "Close"], defaultId: 0, cancelId: 1 })
    .then((answer) => { if (answer === 0) void desktop.invoke(CHANNELS.openExternal, CHATGPT_USAGE_URL); }, () => undefined);
}

export interface AiTurnRun {
  id: string;
  started: Promise<AiStarted>;
  done: Promise<AiTurn>;
  cancel(): void;
}

export function runAi(request: Omit<AiRequest, "id">, onDelta?: (text: string) => void): AiRun {
  const run = runAiTurn(request, onDelta);
  const done = run.done.then((turn) => turn.text);
  done.catch(() => undefined);
  return { ...run, done };
}

export function runAiTurn(request: Omit<AiRequest, "id">, onDelta?: (text: string) => void): AiTurnRun {
  const id = `ai-${Date.now().toString(36)}-${++counter}`;
  let off: () => void = () => undefined;
  let cancelled = false;
  let rejectDone!: (error: AiClientError) => void;
  const done = new Promise<AiTurn>((resolve, reject) => {
    rejectDone = reject;
    off = desktop.on(AI_CHANNELS.event, (raw) => {
      const event = raw as AiEvent;
      if (event.id !== id) return;
      if (event.type === "delta") onDelta?.(event.text);
      else if (event.type === "done") {
        off();
        resolve({ text: event.text, ...(event.toolCalls ? { toolCalls: event.toolCalls } : {}), ...(event.reasoning ? { reasoning: event.reasoning } : {}) });
      } else {
        off();
        planLimit(event.code, event.message);
        reject(new AiClientError(event.code, event.message));
      }
    });
  });
  done.catch(() => undefined);
  const started = desktop.invoke<AiStarted>(AI_CHANNELS.start, { ...request, id });
  void started.then(() => {
    // Cancel can precede model discovery in main; cancel again once its request is registered.
    if (cancelled) void desktop.invoke(AI_CHANNELS.cancel, id).catch(() => undefined);
  }, (error) => {
    off();
    planLimit(undefined, error instanceof Error ? error.message : String(error));
    rejectDone(new AiClientError(cancelled ? "cancelled" : "failed", error instanceof Error ? error.message : String(error)));
  });
  return {
    id, started, done,
    cancel() {
      cancelled = true;
      off();
      rejectDone(new AiClientError("cancelled", "Cancelled."));
      void desktop.invoke(AI_CHANNELS.cancel, id).catch(() => undefined);
    },
  };
}
